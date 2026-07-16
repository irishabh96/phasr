//! Notification-activation seam (DDR-003 §6).
//!
//! When a completion OS notification is clicked, the frontend expects a
//! `phasr://notification-activated { taskId, repositoryId, status }` event so a
//! single `activateWorkspace` code path can focus + route to that workspace
//! (see `useCompletionNotifications.ts`).
//!
//! ## Why this is a *seam*, not a live plugin click handler
//!
//! `tauri-plugin-notification` v2.3.3 delivers desktop notifications
//! fire-and-forget: its `notify` command builds a `notify_rust` notification and
//! `spawn`s `notification.show()`, dropping the handle that could observe a
//! click. On desktop it exposes NO action/click callback and emits NO event on
//! click (`register_listener` / `register_action_types` are mobile-only), and it
//! silently drops the `extra` payload the frontend attaches. So there is no
//! plugin hook we can register in `lib.rs` to emit on click, and the banner
//! itself carries no repo/status back to us.
//!
//! What we CAN own — and do here — is the activation primitive, so whichever
//! click transport the team lands on (a custom NSUserNotification/UN delegate, a
//! future plugin capability, …) closes the loop with a single call:
//!
//!   1. `register_notification_route` — the frontend hands us the routing
//!      metadata each time it fires an OS notification (since the plugin drops
//!      `extra`, Rust can't recover it from the notification). Stored in a small
//!      in-memory `taskId → route` map.
//!   2. `activate_notification` — resolves a `taskId` back to its route and emits
//!      `phasr://notification-activated`. This is the one line a click source
//!      calls.
//!
//! LIMITATION (do not overstate): no OS-level banner click currently reaches
//! `activate_notification` on desktop — the plugin can't deliver it. Every piece
//! here is wired, tested, and callable, but the banner-click → activate loop is
//! not automatically closed on macOS today.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::auth::{AuthError, SessionState};
use crate::domain::WorkspaceStatus;

/// Tauri event the frontend listens on to focus + route to a workspace when its
/// completion notification is activated (DDR-003 §6).
pub const NOTIFICATION_ACTIVATED_EVENT: &str = "phasr://notification-activated";

/// Routing metadata for one workspace's last-fired OS notification. The banner
/// only carries its own identity (the `taskId`); the repo + status needed to
/// route are dropped by the plugin on desktop, so we stash them at fire time and
/// resolve them on activation.
#[derive(Debug, Clone)]
struct NotificationRoute {
    repository_id: String,
    status: Option<WorkspaceStatus>,
}

/// In-memory `taskId → route` map, managed as Tauri state. Minimal by design: it
/// holds only what activation needs and is overwritten per task (last write
/// wins — a re-fired notification for the same task supersedes the old route).
#[derive(Default)]
pub struct NotificationRouteRegistry {
    routes: Mutex<HashMap<String, NotificationRoute>>,
}

impl NotificationRouteRegistry {
    fn record(&self, task_id: String, route: NotificationRoute) {
        self.routes.lock().insert(task_id, route);
    }

    /// Resolve a task's route into the exact payload the frontend destructures.
    /// `None` when no notification was recorded for `task_id`.
    fn resolve(&self, task_id: &str) -> Option<NotificationActivatedPayload> {
        let route = self.routes.lock().get(task_id).cloned()?;
        Some(NotificationActivatedPayload {
            task_id: task_id.to_string(),
            repository_id: route.repository_id,
            status: route.status,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterNotificationRouteInput {
    pub task_id: String,
    pub repository_id: String,
    #[serde(default)]
    pub status: Option<WorkspaceStatus>,
}

/// Payload emitted on `phasr://notification-activated`. Field names/casing must
/// match the frontend listener's destructure in `useCompletionNotifications.ts`:
/// `{ taskId, repositoryId, status }` (status is the lowercase `WorkspaceStatus`
/// wire form).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActivatedPayload {
    pub task_id: String,
    pub repository_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<WorkspaceStatus>,
}

#[derive(Debug)]
pub enum NotificationCmdError {
    Auth(AuthError),
    /// No metadata was recorded for the task — usually means the notification was
    /// never fired (or predates this app session, since the map is in-memory).
    UnknownRoute(String),
    Emit(String),
}

impl From<AuthError> for NotificationCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for NotificationCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auth(e) => write!(f, "{e}"),
            Self::UnknownRoute(id) => write!(f, "no notification route for task {id}"),
            Self::Emit(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for NotificationCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Record routing metadata for a workspace's OS notification. The frontend calls
/// this immediately before `sendNotification`, because the plugin drops `extra`
/// on desktop and the banner would otherwise carry no way back to the
/// repo/status on click.
#[tauri::command]
pub fn register_notification_route(
    input: RegisterNotificationRouteInput,
    registry: State<'_, Arc<NotificationRouteRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), NotificationCmdError> {
    session.require()?;
    registry.record(
        input.task_id,
        NotificationRoute {
            repository_id: input.repository_id,
            status: input.status,
        },
    );
    Ok(())
}

/// Activation seam (DDR-003 §6): resolve a `taskId` to its recorded route and
/// emit `phasr://notification-activated`, which the frontend turns into a focus
/// + navigate. This is the single call a notification-click transport makes;
/// today no desktop OS click reaches it (see module docs).
#[tauri::command]
pub fn activate_notification(
    task_id: String,
    app: tauri::AppHandle,
    registry: State<'_, Arc<NotificationRouteRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), NotificationCmdError> {
    session.require()?;
    let payload = registry
        .resolve(&task_id)
        .ok_or_else(|| NotificationCmdError::UnknownRoute(task_id.clone()))?;
    app.emit(NOTIFICATION_ACTIVATED_EVENT, payload)
        .map_err(|e| NotificationCmdError::Emit(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_resolves_a_route_into_the_frontend_payload() {
        let registry = NotificationRouteRegistry::default();
        registry.record(
            "task-1".to_string(),
            NotificationRoute {
                repository_id: "repo-9".to_string(),
                status: Some(WorkspaceStatus::Completed),
            },
        );

        let payload = registry.resolve("task-1").expect("route was recorded");
        assert_eq!(
            payload,
            NotificationActivatedPayload {
                task_id: "task-1".to_string(),
                repository_id: "repo-9".to_string(),
                status: Some(WorkspaceStatus::Completed),
            }
        );
    }

    #[test]
    fn resolve_is_none_for_an_unrecorded_task() {
        let registry = NotificationRouteRegistry::default();
        assert!(registry.resolve("nope").is_none());
    }

    #[test]
    fn payload_serializes_to_the_camelcase_shape_the_listener_destructures() {
        // Must match `{ taskId, repositoryId, status }` in
        // useCompletionNotifications.ts; status is the lowercase wire form.
        let json = serde_json::to_value(NotificationActivatedPayload {
            task_id: "t".to_string(),
            repository_id: "r".to_string(),
            status: Some(WorkspaceStatus::Failed),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "taskId": "t",
                "repositoryId": "r",
                "status": "failed",
            })
        );
    }

    #[test]
    fn omits_status_when_none() {
        let json = serde_json::to_value(NotificationActivatedPayload {
            task_id: "t".to_string(),
            repository_id: "r".to_string(),
            status: None,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "taskId": "t", "repositoryId": "r" }));
    }

    #[test]
    fn last_write_wins_per_task() {
        let registry = NotificationRouteRegistry::default();
        registry.record(
            "task".to_string(),
            NotificationRoute {
                repository_id: "old".into(),
                status: None,
            },
        );
        registry.record(
            "task".to_string(),
            NotificationRoute {
                repository_id: "new".into(),
                status: Some(WorkspaceStatus::Completed),
            },
        );
        let payload = registry.resolve("task").unwrap();
        assert_eq!(payload.repository_id, "new");
        assert_eq!(payload.status, Some(WorkspaceStatus::Completed));
    }
}
