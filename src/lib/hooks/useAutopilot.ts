import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import { boardKeys } from "@/lib/hooks/useBoard";
import { worklistKeys } from "@/lib/hooks/useWorklist";
import type { AutopilotState } from "@/lib/types";

/** Query keys for the GLOBAL autopilot state (the persisted kill switch, §5). */
export const autopilotKeys = {
  all: ["autopilot"] as const,
  state: () => [...autopilotKeys.all, "state"] as const,
};

/**
 * Read the global autopilot state (`get_autopilot_state`) — the persisted
 * true-halt the "Autopilot halted" banner reads (§5). There is NO auto-resume, so
 * this is refreshed on mount and whenever the kill switch is toggled; it stays
 * fresh across restarts because the halt is persisted server-side.
 */
export function useAutopilotState() {
  return useQuery({
    queryKey: autopilotKeys.state(),
    queryFn: () => tauri.getAutopilotState(),
    // The halt is a persisted, rarely-changing global — a short stale window is
    // plenty; toggles invalidate it explicitly below.
    staleTime: 30_000,
  });
}

/**
 * Toggle autopilot for one epic (`set_autopilot`). Returns the refreshed
 * `BoardState` (its `parent.autopilotEnabled` now carries the new value) — seed
 * the board cache, then invalidate the board + the cross-repo worklist so the
 * neutral toggle, the driven gates, and the "Autopilot driving" grouping all
 * re-derive at once. (The command also emits `phasr://board-changed`, which the
 * open board's own listener picks up — this seeding just makes the toggle feel
 * instant.)
 */
export function useSetAutopilot(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => tauri.setAutopilot(parentId, enabled),
    onSuccess: (board) => {
      queryClient.setQueryData(boardKeys.detail(parentId), board);
      queryClient.invalidateQueries({ queryKey: boardKeys.detail(parentId) });
      queryClient.invalidateQueries({ queryKey: worklistKeys.all });
    },
  });
}

/**
 * Flip the GLOBAL persisted kill switch (`set_autopilot_kill_switch`) — the 2am
 * panic button (halt) and its single explicit un-halt ("Resume", §5). A true
 * halt: no auto-resume, so we simply re-read the persisted state after either
 * direction. Invalidates the worklist too so any autopilot-driven grouping
 * settles back once resumed.
 */
export function useSetAutopilotKillSwitch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (halted: boolean) => tauri.setAutopilotKillSwitch(halted),
    onSuccess: (_void, halted) => {
      queryClient.setQueryData<AutopilotState>(autopilotKeys.state(), {
        killSwitchHalted: halted,
      });
      queryClient.invalidateQueries({ queryKey: autopilotKeys.state() });
      queryClient.invalidateQueries({ queryKey: worklistKeys.all });
    },
  });
}
