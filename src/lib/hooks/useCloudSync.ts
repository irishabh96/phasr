import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * React no longer owns cloud sync. Rust runs the Supabase REST worker;
 * this hook only reacts to worker events and refreshes query caches.
 */
export function useCloudSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["repositories"] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["runCommands"] });
      void queryClient.invalidateQueries({ queryKey: ["userSettings"] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    };

    const unlistenUpdated = listen("cloud-sync-updated", refresh);
    const unlistenError = listen("cloud-sync-error", (event) => {
      console.warn("[cloud sync]", event.payload);
    });

    return () => {
      void unlistenUpdated.then((unlisten) => unlisten());
      void unlistenError.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
