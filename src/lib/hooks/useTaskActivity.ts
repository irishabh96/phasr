import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

/**
 * How long a running workspace's terminal may stay silent before its
 * sidebar activity dot goes out. An agent doing work animates its TUI
 * (spinners, streaming output), so real silence this long means it is
 * sitting at its prompt waiting for the user.
 */
export const ACTIVITY_TIMEOUT_MS = 10 * 60_000;

/** Poll cadence. Coarse on purpose: against a 10-minute timeout, a dot
 * that goes out up to a minute late is imperceptible, and the snapshot
 * is one mutex-guarded map read per poll. */
const POLL_MS = 60_000;

/**
 * Ids of tasks whose terminal produced output within ACTIVITY_TIMEOUT_MS,
 * refreshed every POLL_MS. Returns `null` until the first snapshot
 * arrives, so callers can fail open instead of blinking dots off during
 * boot. All callers share one query — mounting this in every repo section
 * costs one poller, not N.
 */
export function useRecentlyActiveTasks(enabled: boolean): Set<string> | null {
  const activity = useQuery({
    queryKey: ["task-activity"],
    queryFn: tauri.listTaskActivity,
    enabled,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  return useMemo(() => {
    if (!activity.data) return null;
    const now = Date.now();
    return new Set(
      activity.data
        .filter((a) => now - a.lastOutputAt < ACTIVITY_TIMEOUT_MS)
        .map((a) => a.taskId),
    );
  }, [activity.data]);
}
