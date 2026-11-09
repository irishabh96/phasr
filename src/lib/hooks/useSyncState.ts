import { useSystemStatus } from "@/lib/hooks/useTaskCards";
import { useUiStore } from "@/lib/store";
import type { SyncPhase } from "@/lib/types";

export interface SyncState {
  phase: SyncPhase | "unknown";
  /** One line for the account menu ("Synced", "Sync paused: <reason>"). */
  label: string;
  /** The worker's last error, when paused. */
  reason: string | null;
}

/**
 * Cloud-sync health for the title bar (spec D1: the status bar is gone, so
 * the account menu carries the state and the bell shows an error). The
 * backend's `get_system_status` is authoritative; the worker events kept in
 * the store fill in before it answers, and carry the error text.
 */
export function useSyncState(): SyncState {
  const { data: system } = useSystemStatus();
  const cloud = useUiStore((s) => s.cloudSync);
  const phase: SyncState["phase"] =
    system?.sync ?? (cloud.state === "error" ? "error" : cloud.state === "ok" ? "idle" : "unknown");
  const reason = phase === "error" ? (cloud.reason?.trim() || null) : null;
  const label =
    phase === "error"
      ? `Sync paused: ${reason ?? "retrying"}`
      : phase === "syncing"
        ? "Syncing…"
        : phase === "off"
          ? "Sync off"
          : phase === "idle"
            ? "Synced"
            : "Waiting for sync…";
  return { phase, label, reason };
}
