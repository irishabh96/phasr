//! The notifications inbox and the user's delivery preferences.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    /// The agent is blocked on an approval / question.
    NeedsApproval,
    /// The agent finished (its turn ended, or it exited cleanly).
    TaskFinished,
    TaskFailed,
    /// A batch of checks on a task finished.
    ChecksFinished,
    /// A run command (dev server, watcher) exited non-zero on its own.
    RunCommandFailed,
}

impl NotificationKind {
    pub const ALL: [Self; 5] = [
        Self::NeedsApproval,
        Self::TaskFinished,
        Self::TaskFailed,
        Self::ChecksFinished,
        Self::RunCommandFailed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeedsApproval => "needs_approval",
            Self::TaskFinished => "task_finished",
            Self::TaskFailed => "task_failed",
            Self::ChecksFinished => "checks_finished",
            Self::RunCommandFailed => "run_command_failed",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// Covered by the task's own `notify_on_attention` switch: a task that
    /// opted out of attention notifications doesn't raise these.
    pub fn is_attention(self) -> bool {
        matches!(self, Self::NeedsApproval | Self::TaskFinished | Self::TaskFailed)
    }
}

/// One inbox entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppNotification {
    pub id: String,
    pub workspace_id: Option<String>,
    pub repository_id: Option<String>,
    pub kind: NotificationKind,
    pub title: String,
    pub body: Option<String>,
    /// Kind-specific routing data (e.g. `checkRunIds`, `runCommandId`).
    pub payload: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub read_at: Option<DateTime<Utc>>,
}

impl AppNotification {
    pub fn new(kind: NotificationKind, title: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: None,
            repository_id: None,
            kind,
            title: title.into(),
            body: None,
            payload: serde_json::Value::Object(Default::default()),
            created_at: Utc::now(),
            read_at: None,
        }
    }
}

/// How one kind is delivered.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryChannels {
    /// Counts on the inbox bell.
    pub badge: bool,
    /// An OS notification banner.
    pub system: bool,
    pub sound: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuietHours {
    pub enabled: bool,
    /// Local "HH:MM". May wrap midnight (22:00 → 08:00).
    pub start: String,
    pub end: String,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self {
            enabled: false,
            start: "22:00".into(),
            end: "08:00".into(),
        }
    }
}

/// `user_settings.notification_prefs`. Delivery is decided in the frontend
/// (`notificationPolicy.ts::shouldDeliver` — it knows focus and local
/// time); the backend only stores this and always records the inbox entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationPrefs {
    /// Keyed by `NotificationKind::as_str()`. Strings, not the enum, so a
    /// kind a newer build added survives a round trip through this one.
    pub matrix: BTreeMap<String, DeliveryChannels>,
    /// System banners/sounds only while the window isn't focused.
    pub background_only: bool,
    pub quiet_hours: QuietHours,
}

impl NotificationPrefs {
    pub fn default_channels(kind: NotificationKind) -> DeliveryChannels {
        match kind {
            NotificationKind::NeedsApproval => DeliveryChannels {
                badge: true,
                system: true,
                sound: true,
            },
            NotificationKind::TaskFinished
            | NotificationKind::TaskFailed
            | NotificationKind::RunCommandFailed => DeliveryChannels {
                badge: true,
                system: true,
                sound: false,
            },
            NotificationKind::ChecksFinished => DeliveryChannels {
                badge: true,
                system: false,
                sound: false,
            },
        }
    }

    /// Lenient read of the stored JSON: anything unparseable is the
    /// defaults, and kinds missing from a stored matrix get theirs — a
    /// settings row must never become unreadable over this column.
    pub fn from_json(raw: &str) -> Self {
        let mut prefs: Self = serde_json::from_str(raw).unwrap_or_default();
        for kind in NotificationKind::ALL {
            prefs
                .matrix
                .entry(kind.as_str().to_string())
                .or_insert_with(|| Self::default_channels(kind));
        }
        prefs
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            matrix: NotificationKind::ALL
                .into_iter()
                .map(|k| (k.as_str().to_string(), Self::default_channels(k)))
                .collect(),
            background_only: true,
            quiet_hours: QuietHours::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_wire_shape_and_lenient_read() {
        let prefs = NotificationPrefs::default();
        let json = serde_json::to_value(&prefs).unwrap();
        assert_eq!(json["matrix"]["needs_approval"]["sound"], true);
        assert_eq!(json["backgroundOnly"], true);
        assert_eq!(json["quietHours"]["start"], "22:00");
        assert_eq!(json["quietHours"]["end"], "08:00");

        // The column default `{}` and garbage are both the defaults.
        assert_eq!(NotificationPrefs::from_json("{}"), prefs);
        assert_eq!(NotificationPrefs::from_json("not json"), prefs);
        // A partial matrix keeps what's there and fills the rest; an unknown
        // kind survives.
        let partial = NotificationPrefs::from_json(
            r#"{"matrix":{"task_failed":{"badge":false,"system":false,"sound":false},
                "future_kind":{"badge":true,"system":false,"sound":false}},
                "backgroundOnly":false}"#,
        );
        assert!(!partial.matrix["task_failed"].badge);
        assert!(partial.matrix["needs_approval"].system);
        assert!(partial.matrix.contains_key("future_kind"));
        assert!(!partial.background_only);
        assert_eq!(partial.quiet_hours, QuietHours::default());
    }

    #[test]
    fn kinds_round_trip() {
        for kind in NotificationKind::ALL {
            assert_eq!(NotificationKind::from_str(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
    }
}
