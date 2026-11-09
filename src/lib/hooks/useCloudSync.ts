import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { reportP0Warning } from "@/lib/sentry";
import { useUiStore } from "@/lib/store";

/**
 * React no longer owns cloud sync. Rust runs the Supabase REST worker;
 * this hook only reacts to worker events and refreshes query caches.
 */
export function useCloudSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const setCloudSync = useUiStore.getState().setCloudSync;
    const refresh = () => {
      setCloudSync("ok");
      void queryClient.invalidateQueries({ queryKey: ["repositories"] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["runCommands"] });
      void queryClient.invalidateQueries({ queryKey: ["userSettings"] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    };

    const unlistenUpdated = listen("cloud-sync-updated", refresh);
    const unlistenError = listen("cloud-sync-error", (event) => {
      setCloudSync("error");
      // Surface the worker's error in the console too — it was
      // previously Sentry-only, which made sync failures (e.g. a row
      // that never reaches Supabase) invisible during local debugging.
      console.error("[cloud-sync] worker error:", event.payload);
      reportP0Warning("Cloud sync worker reported an error", {
        area: "sync",
        operation: "cloud_sync_worker",
        payload: event.payload,
      });
    });

    return () => {
      void unlistenUpdated.then((unlisten) => unlisten());
      void unlistenError.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
