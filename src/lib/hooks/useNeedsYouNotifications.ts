import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { isAgentPaneActive } from "@/lib/agentPane";
import { ATTENTION_ACTIVATED_EVENT } from "@/lib/events";
import { useOnInboxCreated } from "@/lib/hooks/useInbox";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { workspaceKeys } from "@/lib/hooks/useWorkspaces";
import { initNotificationPermissionState, osNotificationsGranted } from "@/lib/notificationPermission";
import { attentionOnScreen, shouldDeliver } from "@/lib/notificationPolicy";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type { AppNotification, AttentionActivatedPayload, Workspace } from "@/lib/types";

/**
 * Delivery for inbox entries the completion notifier doesn't already cover
 * (needs approval, checks finished, run command failed): the backend records
 * every entry; this decides toast / OS banner from Settings › Notifications
 * (matrix, background-only, quiet hours). Task finished/failed keep their
 * existing focus-routed delivery in `useCompletionNotifications`.
 *
 * Needs approval goes through `notify_attention` (macOS: a banner with
 * Allow / Deny that answers without opening Phasr; a click opens the
 * task's agent pane via `phasr://attention-activated`), and never while
 * its dialog is on screen — the window focused on that task's agent pane.
 *
 * Mount once in the app shell.
 */
const HANDLED_HERE = new Set(["needs_approval", "checks_finished", "run_command_failed"]);

export function useNeedsYouNotifications() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const queryClient = useQueryClient();
  const { data: settings } = useUserSettings();
  const prefsRef = useRef(settings?.notificationPrefs);
  prefsRef.current = settings?.notificationPrefs;

  /** Open a task on its agent pane (where the approval card is). */
  const openAgentPaneRef = useRef((repositoryId: string, taskId: string) => {
    const ws = queryClient.getQueryData<Workspace>(workspaceKeys.detail(taskId));
    useUiStore.getState().openInnerAgentTab(taskId, ws?.command || ws?.name || "Main");
    void navigateRef.current({
      to: "/repositories/$repositoryId/workspaces/$workspaceId",
      params: { repositoryId, workspaceId: taskId },
    });
  });

  useEffect(() => {
    void initNotificationPermissionState();
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    // The backend already raised the window.
    void listen<AttentionActivatedPayload>(ATTENTION_ACTIVATED_EVENT, (event) => {
      const { taskId, repositoryId } = event.payload;
      if (taskId && repositoryId) openAgentPaneRef.current(repositoryId, taskId);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useOnInboxCreated((n: AppNotification) => {
    if (!HANDLED_HERE.has(n.kind)) return;
    const focused = typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
    const taskId = (n.payload.taskId as string | undefined) ?? n.workspaceId ?? null;
    const repositoryId = (n.payload.repositoryId as string | undefined) ?? n.repositoryId ?? null;
    const ui = useUiStore.getState();
    const viewing = !!taskId && ui.activeWorkspaceContext?.workspaceId === taskId;
    const channels = shouldDeliver(prefsRef.current, n.kind, { focused, now: new Date() });
    const attentionId = n.kind === "needs_approval" ? (n.payload.attentionId as string | undefined) : undefined;
    const onScreen =
      n.kind === "needs_approval" &&
      attentionOnScreen({ focused, viewingTask: viewing, onAgentPane: !!taskId && isAgentPaneActive(ui, taskId) });

    const open =
      taskId && repositoryId
        ? () => {
            void getCurrentWindow()
              .setFocus()
              .catch(() => {});
            if (n.kind === "needs_approval") {
              openAgentPaneRef.current(repositoryId, taskId);
              return;
            }
            void navigateRef.current({
              to: "/repositories/$repositoryId/workspaces/$workspaceId",
              params: { repositoryId, workspaceId: taskId },
              ...(n.kind === "checks_finished" ? { search: { pane: "changes" } as never } : {}),
            });
          }
        : null;

    if (!(viewing && focused) && channels.badge) {
      showToast({
        intent: n.kind === "needs_approval" ? "warning" : n.kind === "run_command_failed" ? "error" : "info",
        title: n.title,
        ...(n.body ? { message: n.body } : {}),
        ...(open ? { action: { label: "Open", onClick: open } } : {}),
      });
    }
    if (!channels.system || onScreen || !osNotificationsGranted()) return;
    const plainBanner = () => {
      try {
        sendNotification({ title: n.title, ...(n.body ? { body: n.body } : {}), ...(channels.sound ? { sound: "default" } : {}) });
      } catch {
        /* the toast carries it */
      }
    };
    if (taskId && attentionId) {
      // "stale": the agent moved past that dialog already — say nothing.
      void tauri
        .notifyAttention(taskId, attentionId, channels.sound)
        .then((outcome) => {
          if (outcome === "unsupported") plainBanner();
        })
        .catch(plainBanner);
      return;
    }
    plainBanner();
  });
}
