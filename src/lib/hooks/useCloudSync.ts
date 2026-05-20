import { useAuth, useSession, useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef } from "react";
import {
  deleteRepositoryFromCloud,
  deleteWorkspaceFromCloud,
  pullCustomAgents,
  pullRepositories,
  pullUserSettings,
  pullWorkspaces,
  pushCustomAgents,
  pushMissingRepositories,
  pushMissingWorkspaces,
  pushRepository,
  pushUserSettings,
  pushWorkspace,
} from "@/lib/cloud";
import { isClerkConfigured } from "@/lib/clerk";
import { createPhasrSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { tauri } from "@/lib/tauri";
import type { Repository, UserSettings, Workspace } from "@/lib/types";

const DEBUG = true;
const log = (...args: unknown[]) => {
  if (DEBUG) console.info("[cloud sync]", ...args);
};

/**
 * No-op when Clerk/Supabase aren't configured. In local-only mode this
 * hook short-circuits before any Clerk hook fires — they require a
 * ClerkProvider parent that doesn't exist in the keyless tree.
 */
export function useCloudSync() {
  if (!isClerkConfigured || !isSupabaseConfigured) {
    return;
  }
  return useCloudSyncInner();
}

function useCloudSyncInner() {
  const { isLoaded, isSignedIn } = useAuth();
  const { session } = useSession();
  const { user } = useUser();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const supabase = useMemo(() => {
    if (!isSupabaseConfigured || !session) return null;
    return createPhasrSupabase(async () => (await session.getToken()) ?? null);
  }, [session]);

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const userIdRef = useRef<string | null>(null);
  supabaseRef.current = supabase;
  userIdRef.current = userId ?? null;

  const pulledRef = useRef(false);

  // (1) Bootstrap pull-then-backfill on first sign-in.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !supabase || !userId || pulledRef.current) return;
    pulledRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        log("bootstrap: pulling repositories");
        const cloudRepoIds = await pullRepositories(supabase);
        if (cancelled) return;
        log("bootstrap: pulling custom agents");
        await pullCustomAgents(supabase);
        if (cancelled) return;
        log("bootstrap: pulling workspaces");
        await pullWorkspaces(supabase);
        if (cancelled) return;
        log("bootstrap: pushing custom agents");
        await pushCustomAgents(supabase, userId);
        if (cancelled) return;
        log("bootstrap: syncing user settings");
        await pullUserSettings(supabase);
        if (cancelled) return;
        log("bootstrap: pushing local-only repositories");
        await pushMissingRepositories(supabase, userId, cloudRepoIds);
        if (cancelled) return;
        log("bootstrap: pushing local-only workspaces");
        await pushMissingWorkspaces(supabase, userId);
        if (cancelled) return;
        queryClient.invalidateQueries({ queryKey: ["repositories"] });
        queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        queryClient.invalidateQueries({ queryKey: ["agents"] });
        log("bootstrap complete");
      } catch (err) {
        console.error("[cloud sync] bootstrap failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, supabase, userId, queryClient]);

  // (2) Mirror local mutations, dispatched by mutationKey.
  useEffect(() => {
    const cache = queryClient.getMutationCache();
    return cache.subscribe((event) => {
      const mutation = event.mutation;
      if (!mutation) return;
      const key = mutation.options.mutationKey;
      if (!Array.isArray(key) || key[0] !== "mirror") return;
      const op = key[1] as string;

      if (event.type === "added") {
        log("mutation lifecycle:added", op);
        return;
      }
      if (event.type === "removed") return;
      if (event.type !== "updated") return;

      log("mutation lifecycle:updated", op, mutation.state.status);

      if (mutation.state.status !== "success") return;

      const handler = HANDLERS[op];
      if (!handler) {
        log("no handler for mirror op", op);
        return;
      }

      const tag = mutation as unknown as { __phasrMirrored?: boolean };
      if (tag.__phasrMirrored) return;
      tag.__phasrMirrored = true;

      const supabase = supabaseRef.current;
      const uid = userIdRef.current;
      if (!supabase || !uid) {
        log("skipping mirror (no auth yet)", op);
        return;
      }

      log("mirroring", op);
      handler(supabase, uid, mutation.state.data, mutation.state.variables).catch((err) => {
        console.error(`[cloud sync] ${op} mirror failed`, {
          message: err?.message,
          code: err?.code,
          details: err?.details,
          hint: err?.hint,
          full: err,
        });
      });
    });
  }, [queryClient]);

  // (3) Realtime fan-out: reconcile local store on remote change.
  useEffect(() => {
    if (!supabase || !userId || !session) return;

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    // Realtime is a single WebSocket connection, so the `accessToken`
    // callback on the REST client doesn't reach it. We have to push a
    // fresh JWT into the realtime client explicitly and re-push it on
    // a schedule (Clerk JWTs default to a 60s lifetime).
    const refreshAuth = async () => {
      const token = await session.getToken();
      if (cancelled || !token) return;
      supabase.realtime.setAuth(token);
    };

    log("subscribing to realtime");
    const channel = supabase
      .channel("phasr-sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "repositories", filter: `user_id=eq.${userId}` },
        async (payload) => {
          log("realtime repository", payload.eventType);
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string } | null)?.id;
            if (id) {
              await tauri.deleteRepository(id).catch(() => {});
            }
          } else {
            await pullRepositories(supabase).catch(() => {});
          }
          queryClient.invalidateQueries({ queryKey: ["repositories"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspaces", filter: `user_id=eq.${userId}` },
        async (payload) => {
          log("realtime workspace", payload.eventType);
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string } | null)?.id;
            if (id) {
              await tauri.deleteWorkspace(id).catch(() => {});
            }
          } else {
            await pullWorkspaces(supabase).catch(() => {});
          }
          queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_settings", filter: `user_id=eq.${userId}` },
        async () => {
          log("realtime user_settings");
          await pullUserSettings(supabase).catch(() => {});
          queryClient.invalidateQueries({ queryKey: ["userSettings"] });
        },
      )
      .subscribe((status) => log("realtime channel status", status));

    // Set the initial token, then refresh ahead of expiry.
    void refreshAuth();
    refreshTimer = setInterval(refreshAuth, 45_000);

    return () => {
      cancelled = true;
      if (refreshTimer) clearInterval(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId, session, queryClient]);
}

type MirrorHandler = (
  supabase: SupabaseClient,
  userId: string,
  data: unknown,
  variables: unknown,
) => Promise<void>;

const HANDLERS: Record<string, MirrorHandler> = {
  createRepository: async (sb, userId, data) => {
    if (!data) return;
    await pushRepository(sb, userId, data as Repository);
  },
  updateRepository: async (sb, userId, data) => {
    if (!data) return;
    await pushRepository(sb, userId, data as Repository);
  },
  deleteRepository: async (sb, _userId, _data, variables) => {
    if (typeof variables !== "string") return;
    await deleteRepositoryFromCloud(sb, variables);
  },
  createWorkspace: async (sb, userId, data) => {
    if (!data) return;
    await pushWorkspace(sb, userId, data as Workspace);
  },
  updateWorkspace: async (sb, userId, data) => {
    if (!data) return;
    await pushWorkspace(sb, userId, data as Workspace);
  },
  deleteWorkspace: async (sb, _userId, _data, variables) => {
    if (!variables || typeof variables !== "object" || !("id" in variables)) return;
    const id = (variables as { id: string }).id;
    await deleteWorkspaceFromCloud(sb, id);
  },
  updateUserSettings: async (sb, userId, data) => {
    if (!data) return;
    await pushUserSettings(sb, userId, data as UserSettings);
  },
};

void tauri;
