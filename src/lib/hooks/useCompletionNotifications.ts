import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { repositoryKeys } from "@/lib/hooks/useRepositories";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import {
  initNotificationPermissionState,
  osNotificationsGranted,
} from "@/lib/notificationPermission";
import { useUiStore } from "@/lib/store";
import { showToast, type ToastIntent } from "@/lib/toast";
import type {
  Repository,
  TaskStatusPayload,
  Workspace,
  WorkspaceStatus,
} from "@/lib/types";

/**
 * Agent-completion notifications (DDR-003, Direction A — "focus-routed dual
 * channel"). One side-effect on the existing `phasr://task-status` stream
 * decides, per completed/failed event:
 *
 *   - suppress entirely if the user is currently viewing that workspace
 *     (the in-pane TerminalStatus already shows the exit);
 *   - otherwise ALWAYS enqueue an in-app toast;
 *   - and ONLY when the app is unfocused/hidden, also fire an OS notification
 *     ("do-not-disturb while focused").
 *
 * Near-simultaneous finishes coalesce into one toast + one OS notification.
 * Both channels' click actions route to the workspace via `activateWorkspace`.
 *
 * Mount once, in the app shell alongside `useTaskEvents`.
 */

const COALESCE_WINDOW_MS = 2500;

type BufferedEvent = {
  taskId: string;
  repositoryId: string;
  status: "completed" | "failed";
  exitCode: number | null;
};

/** Payload the Rust side is expected to emit on an OS-notification click. */
interface NotificationActivatedPayload {
  taskId: string;
  repositoryId: string;
  status?: WorkspaceStatus;
}

function isTerminal(status: WorkspaceStatus): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}

/** Resolve the workspace row from cache (detail key first, then repo list). */
function lookupWorkspace(
  qc: QueryClient,
  taskId: string,
  repositoryId: string,
): Workspace | undefined {
  return (
    qc.getQueryData<Workspace>(workspaceKeys.detail(taskId)) ??
    qc
      .getQueryData<Workspace[]>(workspaceKeys.byRepository(repositoryId))
      ?.find((w) => w.id === taskId)
  );
}

/** Resolve the repository name from cache (detail key first, then list). */
function lookupRepositoryName(qc: QueryClient, repositoryId: string): string {
  const repo =
    qc.getQueryData<Repository>(repositoryKeys.detail(repositoryId)) ??
    qc
      .getQueryData<Repository[]>(repositoryKeys.list())
      ?.find((r) => r.id === repositoryId);
  return repo?.name?.trim() || "the repository";
}

/** Workspace name with the DDR-003 fallback (never render `undefined`). */
function workspaceName(qc: QueryClient, taskId: string, repositoryId: string) {
  return (
    lookupWorkspace(qc, taskId, repositoryId)?.name?.trim() || "This workspace"
  );
}

export function useCompletionNotifications() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Refs so the event listeners can be set up exactly once (empty-dep effect)
  // yet always read the current router/query handles.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const qcRef = useRef(queryClient);
  qcRef.current = queryClient;

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    // ── focus tracking (DDR-003 §1) ──────────────────────────────────────
    // `appFocused = tauriWindowFocused && document visible`. Kept in a ref,
    // updated by both the Tauri window focus event and DOM visibility. Default
    // `true` on mount.
    const windowFocusedRef = { current: true };
    const appFocusedRef = { current: true };
    const recompute = () => {
      const visible =
        typeof document === "undefined" ||
        document.visibilityState === "visible";
      appFocusedRef.current = windowFocusedRef.current && visible;
    };
    const onVisibility = () => recompute();
    document.addEventListener("visibilitychange", onVisibility);

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        windowFocusedRef.current = focused;
        recompute();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });

    // ── activation (DDR-003 §6) — both channels do the same thing ────────
    const activateWorkspace = async (
      repositoryId: string,
      taskId: string,
      revealChanges: boolean,
    ) => {
      try {
        const win = getCurrentWindow();
        await win.unminimize();
        await win.setFocus();
      } catch {
        // Focus is best-effort; navigation below still happens.
      }
      if (revealChanges) {
        const store = useUiStore.getState();
        store.setRightPanelCollapsed(false);
        store.setRightPanelTab(taskId, "changes");
      }
      void navigateRef.current({
        to: "/repositories/$repositoryId/workspaces/$workspaceId",
        params: { repositoryId, workspaceId: taskId },
      });
    };

    // ── coalescing buffer (DDR-003 §2) ───────────────────────────────────
    const buffer = new Map<string, BufferedEvent>();
    let latestId: string | null = null;
    let flushTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      const events = Array.from(buffer.values());
      buffer.clear();
      const latest = latestId;
      latestId = null;
      if (events.length === 0) return;

      const qc = qcRef.current;
      // Decide the OS channel at flush time: never buzz while focused.
      const fireOs = !appFocusedRef.current && osNotificationsGranted();

      let toastTitle: string;
      let toastMessage: string;
      let osTitle: string;
      let osBody: string;
      let intent: ToastIntent;
      let actionLabel: string;
      let code: string | undefined;
      let target: { repositoryId: string; taskId: string };
      let revealChanges: boolean;

      if (events.length === 1) {
        const e = events[0]!;
        const w = workspaceName(qc, e.taskId, e.repositoryId);
        const r = lookupRepositoryName(qc, e.repositoryId);
        target = { repositoryId: e.repositoryId, taskId: e.taskId };
        if (e.status === "completed") {
          toastTitle = `${w} finished`;
          toastMessage = `Agent completed in ${r}. Review the changes.`;
          osTitle = `${w} finished`;
          osBody = `Agent completed in ${r}. Click to review changes.`;
          intent = "success";
          actionLabel = "Review changes";
          revealChanges = true;
        } else {
          toastTitle = `${w} failed`;
          toastMessage = `The agent exited with an error in ${r}.`;
          osTitle = `${w} failed`;
          osBody = `The agent exited unexpectedly in ${r}. Click to view.`;
          intent = "error";
          actionLabel = "View workspace";
          revealChanges = false;
          if (e.exitCode != null && e.exitCode !== 0) {
            code = `exit code ${e.exitCode}`;
          }
        }
      } else {
        // Coalesced: ≥2 finishes in the window (DDR-003 §3 "Coalesced").
        const completed = events.filter((e) => e.status === "completed").length;
        const failed = events.length - completed;
        const total = events.length;
        const anyFailed = failed > 0;

        const title = `${total} agents finished`;
        let body: string;
        if (!anyFailed) {
          // Unique repo names in arrival order, truncated after 2 with "+K more".
          const repoNames: string[] = [];
          for (const e of events) {
            const name = lookupRepositoryName(qc, e.repositoryId);
            if (!repoNames.includes(name)) repoNames.push(name);
          }
          const shown = repoNames.slice(0, 2).join(", ");
          const extra = repoNames.length - 2;
          const suffix = extra > 0 ? `, +${extra} more` : "";
          body = `Completed in ${shown}${suffix}. Review them from the sidebar.`;
        } else {
          body = `${completed} completed, ${failed} failed. Review them from the sidebar.`;
        }

        toastTitle = title;
        toastMessage = body;
        osTitle = title;
        osBody = body;
        intent = anyFailed ? "error" : "success";
        actionLabel = "Review latest";

        // "Review latest" → the most-recently-arrived workspace in the batch.
        const latestEvent =
          events.find((e) => e.taskId === latest) ?? events[events.length - 1]!;
        target = {
          repositoryId: latestEvent.repositoryId,
          taskId: latestEvent.taskId,
        };
        revealChanges = latestEvent.status === "completed";
      }

      showToast({
        title: toastTitle,
        message: toastMessage,
        intent,
        ...(code ? { code } : {}),
        action: {
          label: actionLabel,
          onClick: () =>
            void activateWorkspace(
              target.repositoryId,
              target.taskId,
              revealChanges,
            ),
        },
      });

      if (fireOs) {
        // `extra` carries the routing target for a future JS-side click hook;
        // today the click path is the Rust `phasr://notification-activated`
        // event listened for below.
        sendNotification({
          title: osTitle,
          body: osBody,
          extra: {
            taskId: target.taskId,
            repositoryId: target.repositoryId,
            revealChanges,
          },
        });
      }
    };

    // ── the decision function (DDR-003 §1) ───────────────────────────────
    const onTaskStatus = (payload: TaskStatusPayload) => {
      const { taskId, repositoryId, status, exitCode } = payload;
      // Only real completed/failed PTY exits. `stopped` is user-initiated;
      // pending/running/archived carry no completion meaning.
      if (!isTerminal(status)) return;

      // DDR-003 open-Q4 recommendation: only agent workspaces "finish" — a
      // local shell exiting is not an agent completion. Skip only when we can
      // positively confirm the workspace is local (fail-open otherwise).
      const ws = lookupWorkspace(qcRef.current, taskId, repositoryId);
      if (ws?.workspaceKind === "local") return;

      const appFocused = appFocusedRef.current;
      const viewingThis =
        appFocused &&
        useUiStore.getState().activeWorkspaceContext?.workspaceId === taskId;
      if (viewingThis) return; // suppress both channels

      // Dedupe by id inside the window; keep the last status for a re-emit.
      buffer.set(taskId, { taskId, repositoryId, status, exitCode });
      latestId = taskId;
      // Trailing window opens on the FIRST qualifying event and does not reset.
      if (flushTimer == null) {
        flushTimer = window.setTimeout(flush, COALESCE_WINDOW_MS);
      }
    };

    void listen<TaskStatusPayload>("phasr://task-status", (event) => {
      onTaskStatus(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    // ── OS-notification click → same activation path (DDR-003 §6) ─────────
    // TODO(tauri-engineer): the JS plugin does not expose a reliable desktop
    // notification-click callback, so the Rust side must emit
    // `phasr://notification-activated { taskId, repositoryId, status }` on
    // click. This listener is already wired to `activateWorkspace`, so the
    // OS-click → focus + navigate behavior lights up the moment Rust emits it.
    void listen<NotificationActivatedPayload>(
      "phasr://notification-activated",
      (event) => {
        const { taskId, repositoryId, status } = event.payload;
        if (!taskId || !repositoryId) return;
        void activateWorkspace(repositoryId, taskId, status === "completed");
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    // Seed the cached permission flag (no prompt) so the OS guard is accurate
    // for users who granted in a prior session. Cold start never prompts.
    void initNotificationPermissionState();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (flushTimer != null) window.clearTimeout(flushTimer);
      for (const fn of unlisteners) fn();
    };
    // Set up once — the listeners read live handles through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
