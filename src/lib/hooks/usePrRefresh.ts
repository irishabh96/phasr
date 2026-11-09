import { useEffect } from "react";
import { useRefreshPrStates } from "@/lib/hooks/useReview";

const EVERY_MS = 5 * 60_000;

/**
 * Re-read open PRs (gh) when the window regains focus and every 5 minutes,
 * so a PR merged or closed on GitHub moves its task to Done. Mount once.
 */
export function usePrRefresh() {
  const refresh = useRefreshPrStates();
  useEffect(() => {
    const run = () => {
      if (!refresh.isPending) refresh.mutate(null);
    };
    run();
    const timer = window.setInterval(run, EVERY_MS);
    window.addEventListener("focus", run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
    };
    // The mutation object is stable enough; re-subscribing per render isn't wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
