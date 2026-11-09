import { getCurrentWindow } from "@tauri-apps/api/window";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useOnInboxCreated } from "@/lib/hooks/useInbox";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { initNotificationPermissionState, osNotificationsGranted } from "@/lib/notificationPermission";
import { shouldDeliver } from "@/lib/notificationPolicy";
import { useUiStore } from "@/lib/store";
import { showToast } from "@/lib/toast";
import type { AppNotification } from "@/lib/types";

/**
 * Delivery for inbox entries the completion notifier doesn't already cover
 * (needs approval, checks finished, run command failed): the backend records
 * every entry; this decides toast / OS banner from Settings › Notifications
 * (matrix, background-only, quiet hours). Task finished/failed keep their
 * existing focus-routed delivery in `useCompletionNotifications`.
 *
 * Mount once in the app shell.
 */
const HANDLED_HERE = new Set(["needs_approval", "checks_finished", "run_command_failed"]);

export function useNeedsYouNotifications() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const { data: settings } = useUserSettings();
  const prefsRef = useRef(settings?.notificationPrefs);
  prefsRef.current = settings?.notificationPrefs;

  useEffect(() => {
    void initNotificationPermissionState();
  }, []);

  useOnInboxCreated((n: AppNotification) => {
    if (!HANDLED_HERE.has(n.kind)) return;
    const focused = typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
    const taskId = (n.payload.taskId as string | undefined) ?? n.workspaceId ?? null;
    const repositoryId = (n.payload.repositoryId as string | undefined) ?? n.repositoryId ?? null;
    const viewing = !!taskId && useUiStore.getState().activeWorkspaceContext?.workspaceId === taskId;
    const channels = shouldDeliver(prefsRef.current, n.kind, { focused, now: new Date() });

    const open =
      taskId && repositoryId
        ? () => {
            void getCurrentWindow()
              .setFocus()
              .catch(() => {});
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
    if (channels.system && osNotificationsGranted()) {
      try {
        sendNotification({ title: n.title, ...(n.body ? { body: n.body } : {}), ...(channels.sound ? { sound: "default" } : {}) });
      } catch {
        /* the toast carries it */
      }
    }
  });
}
