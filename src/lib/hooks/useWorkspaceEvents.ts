import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

interface WorkspaceStatusPayload {
  workspaceId: string;
  repositoryId: string;
  status: string;
  exitCode: number | null;
}

/**
 * Listens for the `phasr://workspace-status` event Rust emits whenever
 * a workspace's status transitions (e.g. running → completed). Invalidates
 * the relevant TanStack Query keys so visible workspace lists/details
 * refetch exactly once per change, no polling.
 */
export function useWorkspaceEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<WorkspaceStatusPayload>("phasr://workspace-status", (event) => {
      const { workspaceId, repositoryId } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["workspaces", "detail", workspaceId] });
      queryClient.invalidateQueries({
        queryKey: ["workspaces", "repository", repositoryId],
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
}
