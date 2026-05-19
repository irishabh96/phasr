import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

interface TaskStatusPayload {
  taskId: string;
  workspaceId: string;
  status: string;
  exitCode: number | null;
}

/**
 * Listens for the `phasr://task-status` event Rust emits whenever a
 * task row transitions (e.g. running → completed). Invalidates the
 * relevant TanStack Query keys so any visible task list / detail view
 * refetches once, instead of polling on a timer.
 *
 * Mount this once at the app shell level (`_app.tsx`).
 */
export function useTaskEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<TaskStatusPayload>("phasr://task-status", (event) => {
      const { taskId, workspaceId } = event.payload;
      queryClient.invalidateQueries({ queryKey: ["tasks", "detail", taskId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "workspace", workspaceId] });
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
