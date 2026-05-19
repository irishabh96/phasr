import { useAuth, useSession, useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef } from "react";
import {
  deleteTaskFromCloud,
  deleteWorkspaceFromCloud,
  pullTasks,
  pullWorkspaces,
  pushMissingTasks,
  pushMissingWorkspaces,
  pushTask,
  pushWorkspace,
} from "@/lib/cloud";
import { createPhasrSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { tauri } from "@/lib/tauri";
import type { Task, Workspace } from "@/lib/types";

const DEBUG = true;

const log = (...args: unknown[]) => {
  if (DEBUG) console.info("[cloud sync]", ...args);
};

export function useCloudSync() {
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

  // (1) Bootstrap pull-then-backfill-push on first sign-in.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !supabase || !userId || pulledRef.current) return;
    pulledRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        log("bootstrap: pulling workspaces");
        const cloudWorkspaceIds = await pullWorkspaces(supabase);
        if (cancelled) return;
        log("bootstrap: pulling tasks");
        await pullTasks(supabase);
        if (cancelled) return;
        log("bootstrap: pushing local-only workspaces");
        await pushMissingWorkspaces(supabase, userId, cloudWorkspaceIds);
        if (cancelled) return;
        log("bootstrap: pushing local-only tasks");
        await pushMissingTasks(supabase, userId);
        if (cancelled) return;
        queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        log("bootstrap complete");
      } catch (err) {
        console.error("[cloud sync] bootstrap failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, supabase, userId, queryClient]);

  // (2) Mirror local mutations to the cloud, dispatched by mutationKey.
  useEffect(() => {
    const cache = queryClient.getMutationCache();
    return cache.subscribe((event) => {
      const mutation = event.mutation;
      const key = mutation?.options.mutationKey;
      if (!Array.isArray(key) || key[0] !== "mirror") return;
      const op = key[1] as string;

      if (event.type === "added") {
        log("mutation lifecycle:added", op);
        return;
      }
      if (event.type === "removed") {
        log("mutation lifecycle:removed", op);
        return;
      }
      if (event.type !== "updated") return;

      log("mutation lifecycle:updated", op, mutation.state.status);

      if (mutation.state.status !== "success") return;

      const handler = HANDLERS[op];
      if (!handler) {
        log("no handler for mirror op", op);
        return;
      }

      // Dedup: success can fire multiple times as state settles.
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
    if (!supabase || !userId) return;
    log("subscribing to realtime");
    const channel = supabase
      .channel("phasr-sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspaces", filter: `user_id=eq.${userId}` },
        async (payload) => {
          log("realtime workspace", payload.eventType, payload.new ?? payload.old);
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string } | null)?.id;
            if (id) {
              await tauri.deleteWorkspace(id).catch(() => {});
            }
          } else {
            // INSERT / UPDATE → re-run the pull so we apply the changed row.
            await pullWorkspaces(supabase).catch(() => {});
          }
          queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks", filter: `user_id=eq.${userId}` },
        async (payload) => {
          log("realtime task", payload.eventType, payload.new ?? payload.old);
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string } | null)?.id;
            if (id) {
              await tauri.deleteTask(id).catch(() => {});
            }
          } else {
            await pullTasks(supabase).catch(() => {});
          }
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
      )
      .subscribe((status) => log("realtime channel status", status));
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId, queryClient]);
}

type MirrorHandler = (
  supabase: SupabaseClient,
  userId: string,
  data: unknown,
  variables: unknown,
) => Promise<void>;

const HANDLERS: Record<string, MirrorHandler> = {
  createWorkspace: async (sb, userId, data) => {
    if (!data) return;
    await pushWorkspace(sb, userId, data as Workspace);
  },
  updateWorkspace: async (sb, userId, data) => {
    if (!data) return;
    await pushWorkspace(sb, userId, data as Workspace);
  },
  deleteWorkspace: async (sb, _userId, _data, variables) => {
    if (typeof variables !== "string") return;
    await deleteWorkspaceFromCloud(sb, variables);
  },
  createTask: async (sb, userId, data) => {
    if (!data) return;
    await pushTask(sb, userId, data as Task);
  },
  updateTask: async (sb, userId, data) => {
    if (!data) return;
    await pushTask(sb, userId, data as Task);
  },
  deleteTask: async (sb, _userId, _data, variables) => {
    if (!variables || typeof variables !== "object" || !("id" in variables)) return;
    const id = (variables as { id: string }).id;
    await deleteTaskFromCloud(sb, id);
  },
};

void tauri;
