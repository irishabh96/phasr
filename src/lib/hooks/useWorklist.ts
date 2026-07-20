import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

export const worklistKeys = {
  all: ["worklist"] as const,
};

/**
 * The cross-repo attention home's data source (spec §C.3 / §F1). One call
 * returns every repo, every epic board, and loose agents for the signed-in
 * user; the frontend derives the buckets (`deriveWorklist.ts`). Live updates
 * ride the EXISTING `phasr://task-status` stream: `useTaskEvents` invalidates
 * this key on every transition and `useAllAgentLiveness` re-buckets rows in
 * place between refetches — no new subscription (spec §F1).
 */
export function useWorklist() {
  return useQuery({
    queryKey: worklistKeys.all,
    queryFn: () => tauri.listWorklist(),
    // Attention data is cheap to recompute and benefits from freshness on
    // focus; the liveness store handles the sub-second re-bucketing for free.
    staleTime: 10_000,
  });
}
