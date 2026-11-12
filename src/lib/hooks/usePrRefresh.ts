import { useEffect, useRef } from "react";
import { useRefreshPrStates } from "@/lib/hooks/useReview";

const EVERY_MS = 5 * 60_000;

/**
 * Re-read open PRs (gh) when the window regains focus and every 5 minutes,
 * so a PR merged or closed on GitHub moves its task to Done. Mount once.
 *
 * No run on mount: the backend already refreshes at startup, and a second
 * pass at launch raced it (each pass writes outcomes and suggests cleanup).
 * The in-flight guard is a ref — `mutation.isPending` read inside these
 * long-lived listeners is the value from the first render, forever false,
 * so it never stopped an overlapping refresh.
 */
export function usePrRefresh() {
  const refresh = useRefreshPrStates();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const inFlight = useRef(false);

  useEffect(() => {
    const run = () => {
      if (inFlight.current) return;
      inFlight.current = true;
      refreshRef.current.mutate(null, {
        onSettled: () => {
          inFlight.current = false;
        },
      });
    };
    const timer = window.setInterval(run, EVERY_MS);
    window.addEventListener("focus", run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
    };
  }, []);
}
