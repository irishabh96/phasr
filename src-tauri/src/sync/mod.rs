use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::sync::Notify;

use crate::auth::{AuthError, SessionState};
use crate::domain::{
    agent_commands_from_json, NotificationPrefs, PermissionMode, Repository, RunWhen, UserSettings,
};
use crate::store::Db;

const SYNC_INTERVAL: Duration = Duration::from_secs(30);
/// After a mutation trigger, wait briefly so a burst of related writes
/// (e.g. create repo + its local workspace) ride a single sync cycle.
const SYNC_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Debug, Error)]
pub enum SyncError {
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("not signed in")]
    NotSignedIn,
    #[error("invalid sync configuration: {0}")]
    InvalidConfig(String),
    #[error("cloud request failed: {0}")]
    Request(String),
    #[error("cloud returned non-2xx status {status}: {body}")]
    Http { status: StatusCode, body: String },
    #[error("store operation failed: {0}")]
    Store(String),
    #[error("invalid value `{field}`: {message}")]
    InvalidValue {
        field: &'static str,
        message: String,
    },
}

impl serde::Serialize for SyncError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<sqlx::Error> for SyncError {
    fn from(value: sqlx::Error) -> Self {
        Self::Store(value.to_string())
    }
}

/// What the cloud-sync worker is doing — the status bar's sync dot.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncPhase {
    /// No worker (signed out, or sync never started / stopped).
    #[default]
    Off,
    Idle,
    Syncing,
    /// The last cycle failed; the next one retries.
    Error,
}

#[derive(Default)]
pub struct CloudSyncState {
    handle: Mutex<Option<JoinHandle<()>>>,
    /// Signalled by mutating commands so the worker runs a sync cycle
    /// immediately instead of waiting for the next `SYNC_INTERVAL` tick.
    trigger: Arc<Notify>,
    /// Written by the worker around every cycle.
    phase: Arc<Mutex<SyncPhase>>,
}

impl CloudSyncState {
    fn replace(&self, handle: JoinHandle<()>) {
        let mut guard = self.handle.lock();
        if let Some(existing) = guard.take() {
            existing.abort();
        }
        *guard = Some(handle);
    }

    fn stop(&self) {
        if let Some(existing) = self.handle.lock().take() {
            existing.abort();
        }
        *self.phase.lock() = SyncPhase::Off;
    }

    pub fn phase(&self) -> SyncPhase {
        *self.phase.lock()
    }

    /// Ask the running sync worker to push/pull now. Coalesces a burst of
    /// calls into at most one extra cycle (`Notify::notify_one` stores a
    /// single permit). A no-op-but-safe park if no worker is running yet.
    pub fn request_sync(&self) {
        self.trigger.notify_one();
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCloudSyncInput {
    supabase_url: String,
    supabase_anon_key: String,
    /// Legacy fallback only. The effective machine id is derived from the
    /// hardware in Rust (`effective_machine_id`); older frontends still
    /// send their localStorage uuid, which is used only when the hardware
    /// lookup fails.
    #[serde(default)]
    machine_id: Option<String>,
}

#[derive(Debug, Clone)]
struct SyncConfig {
    supabase_url: String,
    supabase_anon_key: String,
    machine_id: String,
}

impl TryFrom<StartCloudSyncInput> for SyncConfig {
    type Error = SyncError;

    fn try_from(input: StartCloudSyncInput) -> Result<Self, Self::Error> {
        let supabase_url = input.supabase_url.trim().trim_end_matches('/').to_string();
        if supabase_url.is_empty() {
            return Err(SyncError::InvalidConfig("missing Supabase URL".into()));
        }
        if !supabase_url.starts_with("https://") && !supabase_url.starts_with("http://") {
            return Err(SyncError::InvalidConfig(
                "Supabase URL must be absolute".into(),
            ));
        }
        if input.supabase_anon_key.trim().is_empty() {
            return Err(SyncError::InvalidConfig("missing Supabase anon key".into()));
        }
        let machine_id = effective_machine_id(input.machine_id.as_deref())?;
        Ok(Self {
            supabase_url,
            supabase_anon_key: input.supabase_anon_key,
            machine_id,
        })
    }
}

/// The key under which this machine's clone paths live in the cloud
/// `repositories.local_paths` map. Derived from the hardware uid
/// (sha256-hashed — the raw IOPlatformUUID never leaves the machine) so it
/// survives a wiped profile; the localStorage uuid it replaces did not,
/// which is how every repo pulled down with `local_path = NULL` after the
/// 2026-08-12 wipe. Falls back to the frontend-supplied legacy id when the
/// hardware lookup fails.
fn effective_machine_id(legacy: Option<&str>) -> Result<String, SyncError> {
    if let Ok(raw) = machine_uid::get() {
        if !raw.trim().is_empty() {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(raw.trim().as_bytes());
            return Ok(format!("{:x}", hasher.finalize()));
        }
    }
    match legacy {
        Some(id) if !id.trim().is_empty() => Ok(id.trim().to_string()),
        _ => Err(SyncError::InvalidConfig(
            "no machine id available (hardware lookup failed and none supplied)".into(),
        )),
    }
}

/// Repositories publish their clone path under the machine id; when that id
/// changes (first run after the hardware-id upgrade, or a restored profile),
/// every cloud row is still keyed by the OLD id. Mark every pathed repo
/// dirty once so the next push re-publishes `local_paths` under the new
/// key, then remember the id in `app_meta`.
async fn note_machine_id_transition(db: &Db, machine_id: &str) -> Result<(), SyncError> {
    let previous: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_meta WHERE key = 'machine_id'")
            .fetch_optional(db)
            .await?;
    if previous.as_deref() == Some(machine_id) {
        return Ok(());
    }
    sqlx::query(
        "UPDATE repositories SET dirty = 1
         WHERE local_path IS NOT NULL AND deleted_at IS NULL",
    )
    .execute(db)
    .await?;
    sqlx::query("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('machine_id', ?)")
        .bind(machine_id)
        .execute(db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn start_cloud_sync(
    input: StartCloudSyncInput,
    session_state: State<'_, Arc<SessionState>>,
    db: State<'_, Db>,
    sync_state: State<'_, Arc<CloudSyncState>>,
    app: AppHandle,
) -> Result<(), SyncError> {
    let session = session_state.require()?.ok_or(SyncError::NotSignedIn)?;
    let config = SyncConfig::try_from(input)?;
    let db = db.inner().clone();
    // Re-publish local_paths under a changed machine id BEFORE the first
    // cycle, so its pull doesn't null out paths keyed under the old id.
    note_machine_id_transition(&db, &config.machine_id).await?;
    let client = SupabaseRestClient::new(config, session.user_id, session.jwt)?;
    let app_for_loop = app.clone();
    let trigger = sync_state.trigger.clone();
    let phase = sync_state.phase.clone();
    *phase.lock() = SyncPhase::Idle;

    let handle = tauri::async_runtime::spawn(async move {
        loop {
            *phase.lock() = SyncPhase::Syncing;
            match sync_once(&client, &db).await {
                Ok(()) => {
                    *phase.lock() = SyncPhase::Idle;
                    let _ = app_for_loop.emit("cloud-sync-updated", ());
                }
                Err(err) => {
                    *phase.lock() = SyncPhase::Error;
                    let _ = app_for_loop.emit("cloud-sync-error", err.to_string());
                }
            }
            // Wake on the periodic sweep OR an explicit mutation trigger,
            // whichever comes first. A short debounce coalesces a burst of
            // mutations into a single follow-up cycle.
            tokio::select! {
                _ = tokio::time::sleep(SYNC_INTERVAL) => {}
                _ = trigger.notified() => {
                    tokio::time::sleep(SYNC_DEBOUNCE).await;
                }
            }
        }
    });

    sync_state.replace(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_cloud_sync(sync_state: State<'_, Arc<CloudSyncState>>) {
    sync_state.stop();
}

async fn sync_once(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    // Each step is independent: a failure in one entity (e.g. a pull
    // that can't deserialize one bad cloud row) must not abort the
    // rest of the cycle. In particular it must never stop dirty
    // workspaces from being pushed. We attempt every step, log each
    // failure with its label, and return the first error so the worker
    // still emits a single `cloud-sync-error` for the UI/Sentry.
    let mut first_err: Option<SyncError> = None;
    macro_rules! step {
        ($label:expr, $fut:expr) => {
            if let Err(err) = $fut.await {
                eprintln!("[cloud-sync] step `{}` failed: {err}", $label);
                if first_err.is_none() {
                    first_err = Some(err);
                }
            }
        };
    }

    step!("push_dirty_users", push_dirty_users(client, db));
    step!("push_repository_deletes", push_repository_deletes(client, db));
    step!("pull_repositories", pull_repositories(client, db));
    step!("push_dirty_repositories", push_dirty_repositories(client, db));
    step!("push_workspace_deletes", push_workspace_deletes(client, db));
    step!("pull_workspaces", pull_workspaces(client, db));
    step!("push_dirty_workspaces", push_dirty_workspaces(client, db));
    step!("pull_run_commands", pull_run_commands(client, db));
    step!("push_dirty_run_commands", push_dirty_run_commands(client, db));
    step!("pull_user_settings", pull_user_settings(client, db));
    step!("push_dirty_user_settings", push_dirty_user_settings(client, db));

    match first_err {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

struct SupabaseRestClient {
    http: reqwest::Client,
    config: SyncConfig,
    user_id: String,
    jwt: String,
}

impl SupabaseRestClient {
    fn new(config: SyncConfig, user_id: String, jwt: String) -> Result<Self, SyncError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|err| SyncError::Request(err.to_string()))?;
        Ok(Self {
            http,
            config,
            user_id,
            jwt,
        })
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, SyncError> {
        let response = self
            .http
            .get(self.url(path))
            .headers(self.headers(false))
            .send()
            .await
            .map_err(|err| SyncError::Request(err.to_string()))?;
        self.decode_response(response).await
    }

    async fn upsert(&self, table: &str, conflict: &str, payload: Value) -> Result<(), SyncError> {
        let path = format!("/rest/v1/{table}?on_conflict={conflict}");
        let response = self
            .http
            .post(self.url(&path))
            .headers(self.headers(true))
            .header("Prefer", "resolution=merge-duplicates,return=minimal")
            .json(&payload)
            .send()
            .await
            .map_err(|err| SyncError::Request(err.to_string()))?;
        self.ensure_success(response).await
    }

    /// PATCH an existing row by id. Unlike `upsert` this never inserts,
    /// so it's the right verb for writing a soft-delete tombstone onto a
    /// row that already exists in the cloud.
    async fn patch_by_id(&self, table: &str, id: &str, payload: Value) -> Result<(), SyncError> {
        let path = format!("/rest/v1/{table}?id=eq.{id}");
        let response = self
            .http
            .patch(self.url(&path))
            .headers(self.headers(true))
            .header("Prefer", "return=minimal")
            .json(&payload)
            .send()
            .await
            .map_err(|err| SyncError::Request(err.to_string()))?;
        self.ensure_success(response).await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.config.supabase_url, path)
    }

    fn headers(&self, json_content: bool) -> reqwest::header::HeaderMap {
        use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};

        let mut headers = HeaderMap::new();
        headers.insert(
            "apikey",
            HeaderValue::from_str(&self.config.supabase_anon_key)
                .expect("validated Supabase anon key"),
        );
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.jwt)).expect("valid bearer token"),
        );
        if json_content {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        headers
    }

    async fn decode_response<T: DeserializeOwned>(
        &self,
        response: reqwest::Response,
    ) -> Result<T, SyncError> {
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|err| SyncError::Request(err.to_string()))?;
        if !status.is_success() {
            return Err(SyncError::Http { status, body });
        }
        serde_json::from_str(&body).map_err(|err| SyncError::Request(err.to_string()))
    }

    async fn ensure_success(&self, response: reqwest::Response) -> Result<(), SyncError> {
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(SyncError::Http { status, body })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct CloudRepositoryRow {
    id: String,
    name: String,
    remote_url: Option<String>,
    #[serde(default)]
    local_paths: HashMap<String, String>,
    default_branch: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[serde(default)]
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
struct CloudWorkspaceRow {
    id: String,
    repository_id: String,
    name: String,
    prompt: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    deleted_at: Option<DateTime<Utc>>,
    command: String,
    status: String,
    branch: Option<String>,
    // F2: present in the cloud schema but intentionally NOT consumed on
    // pull — worktree paths are machine-local and derived locally from the
    // id (see `upsert_workspace_from_cloud`). Kept so this row stays a
    // faithful mirror of the cloud table's shape.
    #[allow(dead_code)]
    worktree_path: Option<String>,
    exit_code: Option<i64>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    archived_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
    // Added in cloud migration 0010. `None` = the column isn't in the
    // payload at all (cloud not migrated yet) → keep the local value;
    // `Some(None)` = genuinely NULL (a legacy skip-all row).
    #[serde(default, deserialize_with = "present")]
    permission_mode: Option<Option<String>>,
    #[serde(default)]
    notify_on_attention: Option<bool>,
    // Added in cloud migration 0011; same absent-vs-null split as
    // `permission_mode`, so an unmigrated cloud never clears a local value.
    #[serde(default, deserialize_with = "present")]
    last_turn_ended_at: Option<Option<DateTime<Utc>>>,
    // Added in cloud migration 0012 (board). Same absent-vs-null split.
    #[serde(default, deserialize_with = "present")]
    base_branch: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    queued_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "present")]
    depends_on_workspace_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    outcome: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    outcome_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "present")]
    merged_into: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pr_number: Option<Option<i64>>,
    #[serde(default, deserialize_with = "present")]
    pr_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pr_state: Option<Option<String>>,
}

/// `(present, value)` binds for a `CASE WHEN ? THEN ? ELSE col END` that
/// applies a cloud column only when the payload carries it.
fn present_text(v: &Option<Option<String>>) -> (bool, Option<String>) {
    (v.is_some(), v.clone().flatten())
}

fn present_time(v: &Option<Option<DateTime<Utc>>>) -> (bool, Option<String>) {
    (v.is_some(), v.flatten().map(|dt| dt.to_rfc3339()))
}

/// Distinguishes "field absent" (`None`, via `serde(default)`) from
/// "field present, null" (`Some(None)`).
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
struct CloudRunCommandRow {
    id: String,
    repository_id: String,
    name: String,
    command: String,
    shortcut: Option<String>,
    pinned: bool,
    sort_order: i64,
    // Added in cloud migration 0013 (review). Absent = the cloud isn't
    // migrated yet → keep the local value (`COALESCE` on pull).
    #[serde(default)]
    run_when: Option<String>,
    #[serde(default)]
    detect_port: Option<bool>,
    #[serde(default)]
    required_for_approve: Option<bool>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
struct CloudUserSettingsRow {
    theme: String,
    accent_color: String,
    sans_font: String,
    mono_font: String,
    base_font_size: i64,
    cursor_style: String,
    cursor_blink: bool,
    terminal_scrollback: i64,
    default_editor: String,
    default_terminal: String,
    #[serde(default)]
    keyboard_shortcuts: Value,
    branch_prefix_template: String,
    worktree_base_path: String,
    default_merge_strategy: String,
    auto_fetch_seconds: i64,
    honor_gpg_sign: bool,
    auto_push_on_commit: bool,
    // Added in cloud migration 0010; absent → keep the local value.
    #[serde(default)]
    default_permission_mode: Option<String>,
    #[serde(default)]
    agent_commands: Option<Value>,
    // Added in cloud migration 0014; absent → keep the local value.
    #[serde(default)]
    notification_prefs: Option<Value>,
    // Added in cloud migration 0015; absent → keep the local value.
    #[serde(default)]
    terminal_shell: Option<String>,
    #[serde(default)]
    copy_on_select: Option<bool>,
    updated_at: DateTime<Utc>,
}

async fn push_dirty_users(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows = sqlx::query(
        "SELECT id, clerk_user_id, name, email, image_url, created_at, updated_at
         FROM users
         WHERE dirty = 1 AND id = ?",
    )
    .bind(&client.user_id)
    .fetch_all(db)
    .await?;

    for row in rows {
        let id: String = row.try_get("id")?;
        let name = required_optional_string(&row, "name")?;
        let email = required_optional_string(&row, "email")?;
        client
            .upsert(
                "users",
                "id",
                json!({
                    "id": &id,
                    "clerk_user_id": row.try_get::<String, _>("clerk_user_id")?,
                    "name": name,
                    "email": email,
                    "image_url": row.try_get::<Option<String>, _>("image_url")?,
                    "created_at": row.try_get::<String, _>("created_at")?,
                    "updated_at": row.try_get::<String, _>("updated_at")?,
                }),
            )
            .await?;
        mark_synced(db, "users", &id).await?;
    }
    Ok(())
}

async fn push_repository_deletes(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows = sqlx::query(
        "SELECT id, deleted_at, updated_at FROM repositories
             WHERE deleted_at IS NOT NULL AND dirty = 1 AND user_id = ?",
    )
    .bind(&client.user_id)
    .fetch_all(db)
    .await?;
    for row in rows {
        let id: String = row.try_get("id")?;
        // Soft-delete in the cloud too: PATCH the tombstone onto the
        // existing row instead of removing it, so the repo (and its
        // children) are preserved remotely.
        client
            .patch_by_id(
                "repositories",
                &id,
                json!({
                    "deleted_at": row.try_get::<String, _>("deleted_at")?,
                    "updated_at": row.try_get::<String, _>("updated_at")?,
                }),
            )
            .await?;
        mark_synced(db, "repositories", &id).await?;
    }
    Ok(())
}

async fn pull_repositories(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows: Vec<CloudRepositoryRow> = client
        .get_json("/rest/v1/repositories?select=*&order=updated_at.desc")
        .await?;
    for row in rows {
        upsert_repository_from_cloud(client, db, &row).await?;
    }
    Ok(())
}

async fn upsert_repository_from_cloud(
    client: &SupabaseRestClient,
    db: &Db,
    row: &CloudRepositoryRow,
) -> Result<(), SyncError> {
    if repository_is_soft_deleted(db, &row.id).await? {
        return Ok(());
    }

    // Cloud tombstone: the repo was soft-deleted on another device.
    // Mirror it locally (hard-delete children, set deleted_at, clear
    // dirty) if we still have a live row, then stop — never resurrect it.
    // `repository_notes` is deliberately absent from the child wipe:
    // notes are the user's todos and outlive the repository, including
    // when the removal arrives from another device.
    //
    // EXCEPT when the live local row is dirty: a pending local write (most
    // importantly a revive — the user just re-added this folder) must not
    // be clobbered by a stale cloud tombstone. The pending push runs later
    // in this same cycle and clears the cloud tombstone instead.
    if row.deleted_at.is_some() {
        let local = get_repository_row(db, &row.id, &client.user_id).await?;
        let local_is_dirty = local.as_ref().is_some_and(|(_, dirty)| *dirty);
        if local.is_some() && !local_is_dirty {
            let mut tx = db.begin().await?;
            for child in ["run_commands", "repository_config", "workspaces"] {
                sqlx::query(&format!("DELETE FROM {child} WHERE repository_id = ?"))
                    .bind(&row.id)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query(
                "UPDATE repositories
                    SET deleted_at = ?, updated_at = ?, synced_at = ?, dirty = 0
                  WHERE id = ?",
            )
            .bind(row.deleted_at.map(|d| d.to_rfc3339()))
            .bind(row.updated_at.to_rfc3339())
            .bind(Utc::now().to_rfc3339())
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
        }
        return Ok(());
    }

    let current = get_repository_row(db, &row.id, &client.user_id).await?;
    let local_path = row
        .local_paths
        .get(&client.config.machine_id)
        .cloned()
        .or_else(|| {
            current
                .as_ref()
                .and_then(|(repo, _)| repo.local_path.clone())
        });

    // A DIFFERENT active local row may already own this path (the local
    // row is authoritative for the folder). Writing it anyway would trip
    // the unique active-local_path index and wedge this sync step forever
    // — land the row pathless instead.
    let local_path = match local_path {
        Some(path) => {
            let taken = sqlx::query(
                "SELECT 1 AS sentinel FROM repositories
                 WHERE local_path = ? AND deleted_at IS NULL AND id != ?",
            )
            .bind(&path)
            .bind(&row.id)
            .fetch_optional(db)
            .await?
            .is_some();
            if taken {
                None
            } else {
                Some(path)
            }
        }
        None => None,
    };

    if let Some((current, _)) = current {
        if current.updated_at >= row.updated_at {
            return Ok(());
        }
        sqlx::query(
            "UPDATE repositories SET
                user_id = ?, name = ?, remote_url = ?, local_path = ?, default_branch = ?,
                created_at = ?, updated_at = ?, synced_at = ?, dirty = 0
             WHERE id = ?",
        )
        .bind(&client.user_id)
        .bind(&row.name)
        .bind(&row.remote_url)
        .bind(&local_path)
        .bind(&row.default_branch)
        .bind(row.created_at.to_rfc3339())
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(&row.id)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO repositories (
                id, user_id, name, remote_url, local_path, default_branch,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(&row.id)
        .bind(&client.user_id)
        .bind(&row.name)
        .bind(&row.remote_url)
        .bind(&local_path)
        .bind(&row.default_branch)
        .bind(row.created_at.to_rfc3339())
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(db)
        .await?;
    }
    Ok(())
}

async fn push_dirty_repositories(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows = dirty_repository_rows(db, &client.user_id).await?;

    for row in rows {
        let repo = repository_from_row(&row)?;
        let mut local_paths = cloud_local_paths(client, &repo.id).await?;
        if let Some(local_path) = repo.local_path.as_deref() {
            local_paths.insert(client.config.machine_id.clone(), local_path.to_string());
        }
        client
            .upsert(
                "repositories",
                "id",
                json!({
                    "id": &repo.id,
                    "user_id": &client.user_id,
                    "name": &repo.name,
                    "remote_url": &repo.remote_url,
                    "local_paths": local_paths,
                    "default_branch": &repo.default_branch,
                    "created_at": repo.created_at,
                    "updated_at": repo.updated_at,
                    // Explicitly null: this push only ever carries LIVE rows
                    // (`deleted_at IS NULL` in dirty_repository_rows), and a
                    // revived repository must clear the cloud-side tombstone
                    // or the next pull would re-delete it locally.
                    "deleted_at": serde_json::Value::Null,
                }),
            )
            .await?;
        mark_synced(db, "repositories", &repo.id).await?;
    }
    Ok(())
}

async fn dirty_repository_rows(
    db: &Db,
    user_id: &str,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, SyncError> {
    Ok(sqlx::query(
        "SELECT id, name, remote_url, local_path, default_branch, created_at, updated_at
         FROM repositories
         WHERE dirty = 1 AND deleted_at IS NULL AND user_id = ?",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

async fn cloud_local_paths(
    client: &SupabaseRestClient,
    repository_id: &str,
) -> Result<HashMap<String, String>, SyncError> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)]
        local_paths: HashMap<String, String>,
    }

    let rows: Vec<Row> = client
        .get_json(&format!(
            "/rest/v1/repositories?id=eq.{repository_id}&select=local_paths"
        ))
        .await?;
    Ok(rows
        .into_iter()
        .next()
        .map(|row| row.local_paths)
        .unwrap_or_default())
}

async fn pull_workspaces(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows: Vec<CloudWorkspaceRow> = client.get_json("/rest/v1/workspaces?select=*").await?;
    let repository_ids = local_repository_ids(db, &client.user_id).await?;
    for row in rows {
        if repository_ids.contains(&row.repository_id) {
            upsert_workspace_from_cloud(client, db, &row).await?;
        }
    }
    Ok(())
}

async fn upsert_workspace_from_cloud(
    client: &SupabaseRestClient,
    db: &Db,
    row: &CloudWorkspaceRow,
) -> Result<(), SyncError> {
    // Already tombstoned locally — never resurrect it.
    if workspace_is_soft_deleted(db, &row.id).await? {
        return Ok(());
    }
    // Cloud tombstone (deleted on another device) — mirror it locally on
    // the live row if we still have one, then stop.
    if row.deleted_at.is_some() {
        sqlx::query(
            "UPDATE workspaces
                SET deleted_at = ?, updated_at = ?, synced_at = ?, dirty = 0
              WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(row.deleted_at.map(|d| d.to_rfc3339()))
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(&row.id)
        .bind(&client.user_id)
        .execute(db)
        .await?;
        return Ok(());
    }

    // F2: `worktree_path` is machine-local, so we never write the value
    // that travelled through the cloud — on a second machine it points at
    // a filesystem path that doesn't exist there, which is exactly what
    // made synced workspaces fail to open. See `local_worktree_path`.
    let worktree_path = local_worktree_path(db, row).await?;

    let base_branch = present_text(&row.base_branch);
    let queued_at = present_time(&row.queued_at);
    let depends_on = present_text(&row.depends_on_workspace_id);
    let outcome = present_text(&row.outcome);
    let outcome_at = present_time(&row.outcome_at);
    let merged_into = present_text(&row.merged_into);
    let pr_url = present_text(&row.pr_url);
    let pr_state = present_text(&row.pr_state);

    let current = get_updated_at(db, "workspaces", &row.id, &client.user_id).await?;
    if let Some(current) = current {
        if current >= row.updated_at {
            return Ok(());
        }
        sqlx::query(
            "UPDATE workspaces SET
                user_id = ?, repository_id = ?, name = ?, prompt = ?, agent = ?, command = ?, status = ?,
                branch = ?, worktree_path = ?, exit_code = ?,
                created_at = ?, started_at = ?, finished_at = ?, archived_at = ?,
                permission_mode = CASE WHEN ? THEN ? ELSE permission_mode END,
                notify_on_attention = COALESCE(?, notify_on_attention),
                last_turn_ended_at = CASE WHEN ? THEN ? ELSE last_turn_ended_at END,
                base_branch = CASE WHEN ? THEN ? ELSE base_branch END,
                queued_at = CASE WHEN ? THEN ? ELSE queued_at END,
                depends_on_workspace_id = CASE WHEN ? THEN ? ELSE depends_on_workspace_id END,
                outcome = CASE WHEN ? THEN ? ELSE outcome END,
                outcome_at = CASE WHEN ? THEN ? ELSE outcome_at END,
                merged_into = CASE WHEN ? THEN ? ELSE merged_into END,
                pr_number = CASE WHEN ? THEN ? ELSE pr_number END,
                pr_url = CASE WHEN ? THEN ? ELSE pr_url END,
                pr_state = CASE WHEN ? THEN ? ELSE pr_state END,
                updated_at = ?, synced_at = ?, dirty = 0
             WHERE id = ?",
        )
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.prompt)
        .bind(&row.agent)
        .bind(&row.command)
        .bind(&row.status)
        .bind(&row.branch)
        .bind(&worktree_path)
        .bind(row.exit_code)
        .bind(row.created_at.to_rfc3339())
        .bind(row.started_at.map(|dt| dt.to_rfc3339()))
        .bind(row.finished_at.map(|dt| dt.to_rfc3339()))
        .bind(row.archived_at.map(|dt| dt.to_rfc3339()))
        .bind(row.permission_mode.is_some())
        .bind(row.permission_mode.clone().flatten())
        .bind(row.notify_on_attention.map(i64::from))
        .bind(row.last_turn_ended_at.is_some())
        .bind(row.last_turn_ended_at.flatten().map(|dt| dt.to_rfc3339()))
        .bind(base_branch.0)
        .bind(base_branch.1.clone())
        .bind(queued_at.0)
        .bind(queued_at.1.clone())
        .bind(depends_on.0)
        .bind(depends_on.1.clone())
        .bind(outcome.0)
        .bind(outcome.1.clone())
        .bind(outcome_at.0)
        .bind(outcome_at.1.clone())
        .bind(merged_into.0)
        .bind(merged_into.1.clone())
        .bind(row.pr_number.is_some())
        .bind(row.pr_number.flatten())
        .bind(pr_url.0)
        .bind(pr_url.1.clone())
        .bind(pr_state.0)
        .bind(pr_state.1.clone())
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(&row.id)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO workspaces (
                id, user_id, repository_id, name, prompt, agent, command, status,
                branch, worktree_path, exit_code,
                created_at, started_at, finished_at, archived_at, updated_at,
                permission_mode, notify_on_attention, last_turn_ended_at,
                base_branch, queued_at, depends_on_workspace_id,
                outcome, outcome_at, merged_into, pr_number, pr_url, pr_state,
                synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(&row.id)
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.prompt)
        .bind(&row.agent)
        .bind(&row.command)
        .bind(&row.status)
        .bind(&row.branch)
        .bind(&worktree_path)
        .bind(row.exit_code)
        .bind(row.created_at.to_rfc3339())
        .bind(row.started_at.map(|dt| dt.to_rfc3339()))
        .bind(row.finished_at.map(|dt| dt.to_rfc3339()))
        .bind(row.archived_at.map(|dt| dt.to_rfc3339()))
        .bind(row.updated_at.to_rfc3339())
        .bind(row.permission_mode.clone().flatten())
        .bind(row.notify_on_attention.map(i64::from))
        .bind(row.last_turn_ended_at.flatten().map(|dt| dt.to_rfc3339()))
        .bind(base_branch.1)
        .bind(queued_at.1)
        .bind(depends_on.1)
        .bind(outcome.1)
        .bind(outcome_at.1)
        .bind(merged_into.1)
        .bind(row.pr_number.flatten())
        .bind(pr_url.1)
        .bind(pr_state.1)
        .bind(Utc::now().to_rfc3339())
        .execute(db)
        .await?;
    }
    Ok(())
}

/// The `worktree_path` to store for a pulled workspace row.
///
/// - No branch → `None`: no worktree was ever created, and deriving a path
///   would trigger a doomed self-heal on open.
/// - This machine already has the row with a worktree that exists on disk
///   → keep it. The worktree base can change after a task was created
///   (Settings → Worktrees); re-deriving on every pull would point a live
///   task at an empty directory under the new base and lose its work.
/// - Otherwise derive `<resolved base>/<id>` from this machine's settings
///   (repository override > user setting > default). On first open,
///   `cwd_for_task` self-heals the missing dir from the branch (F1).
///
/// The push side stores NULL remotely so nothing leaks a local absolute
/// path to the cloud.
async fn local_worktree_path(db: &Db, row: &CloudWorkspaceRow) -> Result<Option<String>, SyncError> {
    if row.branch.is_none() {
        return Ok(None);
    }
    let existing: Option<String> = sqlx::query_scalar("SELECT worktree_path FROM workspaces WHERE id = ?")
        .bind(&row.id)
        .fetch_optional(db)
        .await?
        .flatten();
    if let Some(path) = existing.filter(|p| std::path::Path::new(p).exists()) {
        return Ok(Some(path));
    }
    let config = crate::store::RepositoryConfigRepo::new(db.clone())
        .get(&row.repository_id)
        .await
        .map_err(|e| SyncError::Store(e.to_string()))?;
    let settings = crate::store::SettingsRepo::new(db.clone())
        .get_or_default()
        .await
        .map_err(|e| SyncError::Store(e.to_string()))?;
    Ok(Some(
        crate::git::resolve_worktree_base(config.worktree_base(&settings))
            .join(&row.id)
            .to_string_lossy()
            .into_owned(),
    ))
}

async fn push_dirty_workspaces(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows = dirty_workspace_rows(db, &client.user_id).await?;

    for row in rows {
        let id: String = row.try_get("id")?;
        client
            .upsert(
                "workspaces",
                "id",
                json!({
                    "id": &id,
                    "user_id": &client.user_id,
                    "repository_id": row.try_get::<String, _>("repository_id")?,
                    "name": row.try_get::<String, _>("name")?,
                    "prompt": row.try_get::<Option<String>, _>("prompt")?,
                    "agent": row.try_get::<Option<String>, _>("agent")?,
                    "command": row.try_get::<String, _>("command")?,
                    "status": row.try_get::<String, _>("status")?,
                    "branch": row.try_get::<Option<String>, _>("branch")?,
                    // F2: never publish a machine-local worktree path to the
                    // cloud — it's derived locally from the id on pull. Store
                    // NULL so a second machine can't inherit a dead path.
                    "worktree_path": Value::Null,
                    "exit_code": row.try_get::<Option<i64>, _>("exit_code")?,
                    "created_at": row.try_get::<String, _>("created_at")?,
                    "started_at": row.try_get::<Option<String>, _>("started_at")?,
                    "finished_at": row.try_get::<Option<String>, _>("finished_at")?,
                    "archived_at": row.try_get::<Option<String>, _>("archived_at")?,
                    "updated_at": row.try_get::<String, _>("updated_at")?,
                    "permission_mode": row.try_get::<Option<String>, _>("permission_mode")?,
                    "notify_on_attention": row.try_get::<i64, _>("notify_on_attention")? != 0,
                    "last_turn_ended_at": row.try_get::<Option<String>, _>("last_turn_ended_at")?,
                    "base_branch": row.try_get::<Option<String>, _>("base_branch")?,
                    "queued_at": row.try_get::<Option<String>, _>("queued_at")?,
                    "depends_on_workspace_id": row.try_get::<Option<String>, _>("depends_on_workspace_id")?,
                    "outcome": row.try_get::<Option<String>, _>("outcome")?,
                    "outcome_at": row.try_get::<Option<String>, _>("outcome_at")?,
                    "merged_into": row.try_get::<Option<String>, _>("merged_into")?,
                    "pr_number": row.try_get::<Option<i64>, _>("pr_number")?,
                    "pr_url": row.try_get::<Option<String>, _>("pr_url")?,
                    "pr_state": row.try_get::<Option<String>, _>("pr_state")?,
                }),
            )
            .await?;
        mark_synced(db, "workspaces", &id).await?;
    }
    Ok(())
}

async fn dirty_workspace_rows(
    db: &Db,
    user_id: &str,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, SyncError> {
    Ok(sqlx::query(
        "SELECT id, repository_id, name, prompt, agent, command, status, branch, worktree_path,
                exit_code, created_at, started_at, finished_at, archived_at, updated_at,
                permission_mode, notify_on_attention, last_turn_ended_at,
                base_branch, queued_at, depends_on_workspace_id,
                outcome, outcome_at, merged_into, pr_number, pr_url, pr_state
         FROM workspaces
         WHERE dirty = 1 AND deleted_at IS NULL AND user_id = ? AND workspace_kind = 'agent'",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

/// Push workspace soft-deletes: PATCH the `deleted_at` tombstone onto the
/// cloud row instead of leaving it live (which the next pull would
/// re-insert locally). Mirrors `push_repository_deletes`.
async fn push_workspace_deletes(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows = sqlx::query(
        "SELECT id, deleted_at, updated_at FROM workspaces
             WHERE deleted_at IS NOT NULL AND dirty = 1
               AND user_id = ? AND workspace_kind = 'agent'",
    )
    .bind(&client.user_id)
    .fetch_all(db)
    .await?;
    for row in rows {
        let id: String = row.try_get("id")?;
        client
            .patch_by_id(
                "workspaces",
                &id,
                json!({
                    "deleted_at": row.try_get::<String, _>("deleted_at")?,
                    "updated_at": row.try_get::<String, _>("updated_at")?,
                }),
            )
            .await?;
        mark_synced(db, "workspaces", &id).await?;
    }
    Ok(())
}

/// Not user-scoped for the same reason as `repository_is_soft_deleted`:
/// a `user_id IS NULL` tombstone must still block resurrection.
async fn workspace_is_soft_deleted(db: &Db, id: &str) -> Result<bool, SyncError> {
    let row = sqlx::query(
        "SELECT 1 AS sentinel FROM workspaces
         WHERE id = ? AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

async fn pull_run_commands(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows: Vec<CloudRunCommandRow> = client.get_json("/rest/v1/run_commands?select=*").await?;
    let repository_ids = local_repository_ids(db, &client.user_id).await?;
    for row in rows {
        if repository_ids.contains(&row.repository_id) {
            upsert_run_command_from_cloud(client, db, &row).await?;
        }
    }
    Ok(())
}

async fn upsert_run_command_from_cloud(
    client: &SupabaseRestClient,
    db: &Db,
    row: &CloudRunCommandRow,
) -> Result<(), SyncError> {
    let current = get_updated_at(db, "run_commands", &row.id, &client.user_id).await?;
    if let Some(current) = current {
        if current >= row.updated_at {
            return Ok(());
        }
        sqlx::query(
            "UPDATE run_commands SET
                user_id = ?, repository_id = ?, name = ?, command = ?, shortcut = ?, pinned = ?,
                sort_order = ?,
                run_when = COALESCE(?, run_when),
                detect_port = COALESCE(?, detect_port),
                required_for_approve = COALESCE(?, required_for_approve),
                created_at = ?, updated_at = ?, synced_at = ?, dirty = 0
             WHERE id = ?",
        )
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.command)
        .bind(&row.shortcut)
        .bind(row.pinned as i64)
        .bind(row.sort_order)
        .bind(cloud_run_when(row))
        .bind(row.detect_port.map(i64::from))
        .bind(row.required_for_approve.map(i64::from))
        .bind(row.created_at.to_rfc3339())
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(&row.id)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO run_commands (
                id, user_id, repository_id, name, command, shortcut, pinned, sort_order,
                run_when, detect_port, required_for_approve,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'manual'), COALESCE(?, 0),
                      COALESCE(?, 0), ?, ?, ?, 0)",
        )
        .bind(&row.id)
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.command)
        .bind(&row.shortcut)
        .bind(row.pinned as i64)
        .bind(row.sort_order)
        .bind(cloud_run_when(row))
        .bind(row.detect_port.map(i64::from))
        .bind(row.required_for_approve.map(i64::from))
        .bind(row.created_at.to_rfc3339())
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(db)
        .await?;
    }
    Ok(())
}

/// The cloud's `run_when`, normalized: a value this build doesn't know (a
/// newer client's trigger) is stored as `manual` rather than kept verbatim,
/// so nothing this build can't reason about ever auto-runs. `None` = the
/// column isn't in the payload (cloud not migrated) → keep the local value.
fn cloud_run_when(row: &CloudRunCommandRow) -> Option<&'static str> {
    row.run_when.as_deref().map(|w| RunWhen::parse_lenient(w).as_str())
}

async fn push_dirty_run_commands(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows = dirty_run_command_rows(db, &client.user_id).await?;

    for row in rows {
        let id: String = row.try_get("id")?;
        client
            .upsert(
                "run_commands",
                "id",
                json!({
                    "id": &id,
                    "user_id": &client.user_id,
                    "repository_id": row.try_get::<String, _>("repository_id")?,
                    "name": row.try_get::<String, _>("name")?,
                    "command": row.try_get::<String, _>("command")?,
                    "shortcut": row.try_get::<Option<String>, _>("shortcut")?,
                    "pinned": row.try_get::<i64, _>("pinned")? != 0,
                    "sort_order": row.try_get::<i64, _>("sort_order")?,
                    "run_when": row.try_get::<String, _>("run_when")?,
                    "detect_port": row.try_get::<i64, _>("detect_port")? != 0,
                    "required_for_approve": row.try_get::<i64, _>("required_for_approve")? != 0,
                    "created_at": row.try_get::<String, _>("created_at")?,
                    "updated_at": row.try_get::<String, _>("updated_at")?,
                }),
            )
            .await?;
        mark_synced(db, "run_commands", &id).await?;
    }
    Ok(())
}

async fn dirty_run_command_rows(
    db: &Db,
    user_id: &str,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, SyncError> {
    Ok(sqlx::query(
        "SELECT id, repository_id, name, command, shortcut, pinned, sort_order,
                run_when, detect_port, required_for_approve, created_at, updated_at
         FROM run_commands
         WHERE dirty = 1 AND user_id = ?",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

async fn pull_user_settings(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let rows: Vec<CloudUserSettingsRow> = client
        .get_json("/rest/v1/user_settings?select=*&limit=1")
        .await?;
    let Some(row) = rows.into_iter().next() else {
        return Ok(());
    };
    let Some(local) = get_or_init_user_settings(db, &client.user_id).await? else {
        return Ok(());
    };
    if local.updated_at >= row.updated_at {
        return Ok(());
    }
    sqlx::query(
        "UPDATE user_settings SET
            theme = ?, accent_color = ?, sans_font = ?, mono_font = ?,
            base_font_size = ?, cursor_style = ?, cursor_blink = ?,
            terminal_scrollback = ?, default_editor = ?, default_terminal = ?,
            keyboard_shortcuts = ?,
            branch_prefix_template = ?, worktree_base_path = ?,
            default_merge_strategy = ?, auto_fetch_seconds = ?,
            honor_gpg_sign = ?, auto_push_on_commit = ?,
            default_permission_mode = COALESCE(?, default_permission_mode),
            agent_commands = COALESCE(?, agent_commands),
            notification_prefs = COALESCE(?, notification_prefs),
            terminal_shell = COALESCE(?, terminal_shell),
            copy_on_select = COALESCE(?, copy_on_select),
            updated_at = ?, synced_at = ?, dirty = 0, user_id = ?
         WHERE id = 1 AND (user_id IS NULL OR user_id = ?)",
    )
    .bind(&row.theme)
    .bind(&row.accent_color)
    .bind(&row.sans_font)
    .bind(&row.mono_font)
    .bind(row.base_font_size)
    .bind(&row.cursor_style)
    .bind(row.cursor_blink as i64)
    .bind(row.terminal_scrollback)
    .bind(&row.default_editor)
    .bind(&row.default_terminal)
    .bind(row.keyboard_shortcuts.to_string())
    .bind(&row.branch_prefix_template)
    .bind(&row.worktree_base_path)
    .bind(&row.default_merge_strategy)
    .bind(row.auto_fetch_seconds)
    .bind(row.honor_gpg_sign as i64)
    .bind(row.auto_push_on_commit as i64)
    // Ignore a mode string this build doesn't know (written by a newer
    // client) rather than storing a value it would then misread.
    .bind(
        row.default_permission_mode
            .as_deref()
            .and_then(PermissionMode::from_str)
            .map(PermissionMode::as_str),
    )
    // Only a JSON object is a valid override map.
    .bind(
        row.agent_commands
            .as_ref()
            .filter(|v| v.is_object())
            .map(Value::to_string),
    )
    .bind(
        row.notification_prefs
            .as_ref()
            .filter(|v| v.is_object())
            .map(Value::to_string),
    )
    .bind(row.terminal_shell.as_deref())
    .bind(row.copy_on_select.map(i64::from))
    .bind(row.updated_at.to_rfc3339())
    .bind(Utc::now().to_rfc3339())
    .bind(&client.user_id)
    .bind(&client.user_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn push_dirty_user_settings(client: &SupabaseRestClient, db: &Db) -> Result<(), SyncError> {
    let row = sqlx::query(
        "SELECT theme, accent_color, sans_font, mono_font, base_font_size,
                cursor_style, cursor_blink, terminal_scrollback, default_editor,
                default_terminal,
                keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                default_merge_strategy, auto_fetch_seconds, honor_gpg_sign,
                auto_push_on_commit, default_permission_mode, agent_commands,
                notification_prefs, terminal_shell, copy_on_select, updated_at
         FROM user_settings
         WHERE id = 1 AND dirty = 1 AND user_id = ?",
    )
    .bind(&client.user_id)
    .fetch_optional(db)
    .await?;

    let Some(row) = row else {
        return Ok(());
    };
    let updated_at: String = row.try_get("updated_at")?;
    client
        .upsert(
            "user_settings",
            "user_id",
            json!({
                "user_id": &client.user_id,
                "theme": row.try_get::<String, _>("theme")?,
                "accent_color": row.try_get::<String, _>("accent_color")?,
                "sans_font": row.try_get::<String, _>("sans_font")?,
                "mono_font": row.try_get::<String, _>("mono_font")?,
                "base_font_size": row.try_get::<i64, _>("base_font_size")?,
                "cursor_style": row.try_get::<String, _>("cursor_style")?,
                "cursor_blink": row.try_get::<i64, _>("cursor_blink")? != 0,
                "terminal_scrollback": row.try_get::<i64, _>("terminal_scrollback")?,
                "default_editor": row.try_get::<String, _>("default_editor")?,
                "default_terminal": row.try_get::<String, _>("default_terminal")?,
                "keyboard_shortcuts": parse_json_column(row.try_get("keyboard_shortcuts")?)?,
                "branch_prefix_template": row.try_get::<String, _>("branch_prefix_template")?,
                "worktree_base_path": row.try_get::<String, _>("worktree_base_path")?,
                "default_merge_strategy": row.try_get::<String, _>("default_merge_strategy")?,
                "auto_fetch_seconds": row.try_get::<i64, _>("auto_fetch_seconds")?,
                "honor_gpg_sign": row.try_get::<i64, _>("honor_gpg_sign")? != 0,
                "auto_push_on_commit": row.try_get::<i64, _>("auto_push_on_commit")? != 0,
                "default_permission_mode": row.try_get::<String, _>("default_permission_mode")?,
                "agent_commands": parse_json_column(row.try_get("agent_commands")?)?,
                "notification_prefs": parse_json_column(row.try_get("notification_prefs")?)?,
                "terminal_shell": row.try_get::<String, _>("terminal_shell")?,
                "copy_on_select": row.try_get::<i64, _>("copy_on_select")? != 0,
                "updated_at": updated_at,
            }),
        )
        .await?;
    sqlx::query("UPDATE user_settings SET synced_at = ?, dirty = 0 WHERE id = 1")
        .bind(Utc::now().to_rfc3339())
        .execute(db)
        .await?;
    Ok(())
}

async fn get_or_init_user_settings(
    db: &Db,
    user_id: &str,
) -> Result<Option<UserSettings>, SyncError> {
    let existing = sqlx::query(
        "SELECT user_id, theme, accent_color, sans_font, mono_font, base_font_size,
                cursor_style, cursor_blink, terminal_scrollback, default_editor,
                default_terminal,
                keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                default_merge_strategy, auto_fetch_seconds, honor_gpg_sign,
                auto_push_on_commit, default_permission_mode, agent_commands,
                notification_prefs, terminal_shell, copy_on_select, updated_at
         FROM user_settings
         WHERE id = 1",
    )
    .fetch_optional(db)
    .await?;
    if let Some(row) = existing {
        let owner = row.try_get::<Option<String>, _>("user_id")?;
        if owner.as_deref().is_some_and(|owner| owner != user_id) {
            return Ok(None);
        }
        if owner.is_none() {
            sqlx::query("UPDATE user_settings SET user_id = ? WHERE id = 1 AND user_id IS NULL")
                .bind(user_id)
                .execute(db)
                .await?;
        }
        return Ok(Some(UserSettings {
            theme: row.try_get("theme")?,
            accent_color: row.try_get("accent_color")?,
            sans_font: row.try_get("sans_font")?,
            mono_font: row.try_get("mono_font")?,
            base_font_size: row.try_get("base_font_size")?,
            cursor_style: row.try_get("cursor_style")?,
            cursor_blink: row.try_get::<i64, _>("cursor_blink")? != 0,
            terminal_scrollback: row.try_get("terminal_scrollback")?,
            default_editor: row.try_get("default_editor")?,
            default_terminal: row.try_get("default_terminal")?,
            keyboard_shortcuts: row.try_get("keyboard_shortcuts")?,
            branch_prefix_template: row.try_get("branch_prefix_template")?,
            worktree_base_path: row.try_get("worktree_base_path")?,
            default_merge_strategy: row.try_get("default_merge_strategy")?,
            auto_fetch_seconds: row.try_get("auto_fetch_seconds")?,
            honor_gpg_sign: row.try_get::<i64, _>("honor_gpg_sign")? != 0,
            auto_push_on_commit: row.try_get::<i64, _>("auto_push_on_commit")? != 0,
            default_permission_mode: PermissionMode::from_str(
                &row.try_get::<String, _>("default_permission_mode")?,
            )
            .unwrap_or_default(),
            agent_commands: agent_commands_from_json(&row.try_get::<String, _>("agent_commands")?),
            notification_prefs: NotificationPrefs::from_json(
                &row.try_get::<String, _>("notification_prefs")?,
            ),
            terminal_shell: row.try_get("terminal_shell")?,
            copy_on_select: row.try_get::<i64, _>("copy_on_select")? != 0,
            updated_at: parse_timestamp(row.try_get("updated_at")?, "updated_at")?,
        }));
    }

    let defaults = UserSettings::default();
    sqlx::query(
        "INSERT INTO user_settings (
            id, user_id, theme, accent_color, sans_font, mono_font, base_font_size,
            cursor_style, cursor_blink, terminal_scrollback, default_editor,
            default_terminal,
            keyboard_shortcuts, branch_prefix_template, worktree_base_path,
            default_merge_strategy, auto_fetch_seconds, honor_gpg_sign,
            auto_push_on_commit, updated_at, synced_at, dirty
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
    )
    .bind(user_id)
    .bind(&defaults.theme)
    .bind(&defaults.accent_color)
    .bind(&defaults.sans_font)
    .bind(&defaults.mono_font)
    .bind(defaults.base_font_size)
    .bind(&defaults.cursor_style)
    .bind(defaults.cursor_blink as i64)
    .bind(defaults.terminal_scrollback)
    .bind(&defaults.default_editor)
    .bind(&defaults.default_terminal)
    .bind(&defaults.keyboard_shortcuts)
    .bind(&defaults.branch_prefix_template)
    .bind(&defaults.worktree_base_path)
    .bind(&defaults.default_merge_strategy)
    .bind(defaults.auto_fetch_seconds)
    .bind(defaults.honor_gpg_sign as i64)
    .bind(defaults.auto_push_on_commit as i64)
    .bind(defaults.updated_at.to_rfc3339())
    .execute(db)
    .await?;
    Ok(Some(defaults))
}

async fn local_repository_ids(db: &Db, user_id: &str) -> Result<HashSet<String>, SyncError> {
    let rows = sqlx::query("SELECT id FROM repositories WHERE deleted_at IS NULL AND user_id = ?")
        .bind(user_id)
        .fetch_all(db)
        .await?;
    rows.iter()
        .map(|row| row.try_get::<String, _>("id").map_err(SyncError::from))
        .collect()
}

/// The live local row plus its `dirty` flag — the pull path needs the flag
/// to avoid clobbering rows with pending local writes.
async fn get_repository_row(
    db: &Db,
    id: &str,
    user_id: &str,
) -> Result<Option<(Repository, bool)>, SyncError> {
    let row = sqlx::query(
        "SELECT id, name, remote_url, local_path, default_branch, created_at, updated_at, dirty
         FROM repositories
         WHERE id = ? AND deleted_at IS NULL AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.as_ref()
        .map(|row| {
            let dirty: i64 = row.try_get("dirty")?;
            Ok((repository_from_row(row)?, dirty != 0))
        })
        .transpose()
}

fn repository_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Repository, SyncError> {
    Ok(Repository {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        remote_url: row.try_get("remote_url")?,
        local_path: row.try_get("local_path")?,
        default_branch: row.try_get("default_branch")?,
        created_at: parse_timestamp(row.try_get("created_at")?, "created_at")?,
        updated_at: parse_timestamp(row.try_get("updated_at")?, "updated_at")?,
    })
}

/// Deliberately NOT user-scoped: ids are UUIDs, and a tombstone written
/// before `user_id` stamping existed (or by a legacy code path) has
/// `user_id IS NULL` — a user-scoped check can't see it, and the pull then
/// resurrects a repository the user explicitly deleted.
async fn repository_is_soft_deleted(db: &Db, id: &str) -> Result<bool, SyncError> {
    let row = sqlx::query(
        "SELECT 1 AS sentinel FROM repositories
         WHERE id = ? AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

async fn get_updated_at(
    db: &Db,
    table: &'static str,
    id: &str,
    user_id: &str,
) -> Result<Option<DateTime<Utc>>, SyncError> {
    let sql = match table {
        "workspaces" => "SELECT updated_at FROM workspaces WHERE id = ? AND user_id = ?",
        "run_commands" => "SELECT updated_at FROM run_commands WHERE id = ? AND user_id = ?",
        _ => {
            return Err(SyncError::InvalidValue {
                field: "table",
                message: table.into(),
            })
        }
    };
    let row = sqlx::query(sql)
        .bind(id)
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    row.map(|row| parse_timestamp(row.try_get("updated_at")?, "updated_at"))
        .transpose()
}

async fn mark_synced(db: &Db, table: &'static str, id: &str) -> Result<(), SyncError> {
    let sql = match table {
        "users" => "UPDATE users SET synced_at = ?, dirty = 0 WHERE id = ?",
        "repositories" => "UPDATE repositories SET synced_at = ?, dirty = 0 WHERE id = ?",
        "workspaces" => "UPDATE workspaces SET synced_at = ?, dirty = 0 WHERE id = ?",
        "run_commands" => "UPDATE run_commands SET synced_at = ?, dirty = 0 WHERE id = ?",
        _ => {
            return Err(SyncError::InvalidValue {
                field: "table",
                message: table.into(),
            })
        }
    };
    sqlx::query(sql)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

fn required_optional_string(
    row: &sqlx::sqlite::SqliteRow,
    field: &'static str,
) -> Result<String, SyncError> {
    row.try_get::<Option<String>, _>(field)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| SyncError::InvalidValue {
            field,
            message: "missing required user profile value".into(),
        })
}

fn parse_timestamp(value: String, field: &'static str) -> Result<DateTime<Utc>, SyncError> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|err| SyncError::InvalidValue {
            field,
            message: err.to_string(),
        })
}

fn parse_json_column(value: String) -> Result<Value, SyncError> {
    serde_json::from_str(&value).map_err(|err| SyncError::InvalidValue {
        field: "json",
        message: err.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;
    use std::path::PathBuf;

    async fn fresh_db() -> Db {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        pool
    }

    fn test_client(user_id: &str) -> SupabaseRestClient {
        client_at(user_id, "http://127.0.0.1:1")
    }

    /// Like `test_client` but pointed at a given base URL (a wiremock
    /// mock server). Builds `SyncConfig` directly so it skips the
    /// `https://`-only check in `SyncConfig::try_from`.
    fn client_at(user_id: &str, base_url: &str) -> SupabaseRestClient {
        SupabaseRestClient::new(
            SyncConfig {
                supabase_url: base_url.into(),
                supabase_anon_key: "anon".into(),
                machine_id: "machine-a".into(),
            },
            user_id.into(),
            "jwt".into(),
        )
        .unwrap()
    }

    async fn insert_repo(db: &Db, id: &str, user_id: &str, dirty: i64) {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO repositories (id, user_id, name, default_branch, created_at, updated_at, dirty)
             VALUES (?, ?, 'R', 'main', ?, ?, ?)",
        )
        .bind(id)
        .bind(user_id)
        .bind(&now)
        .bind(&now)
        .bind(dirty)
        .execute(db)
        .await
        .unwrap();
    }

    async fn insert_agent_workspace(db: &Db, id: &str, user_id: &str, repo_id: &str, agent: &str) {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO workspaces (
                id, user_id, repository_id, workspace_kind, name, agent, command, status,
                created_at, updated_at, dirty
             ) VALUES (?, ?, ?, 'agent', 'W', ?, 'run', 'stopped', ?, ?, 1)",
        )
        .bind(id)
        .bind(user_id)
        .bind(repo_id)
        .bind(agent)
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await
        .unwrap();
    }

    async fn insert_user(db: &Db, id: &str) {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, created_at, updated_at, dirty)
             VALUES (?, ?, ?, ?, 0)",
        )
        .bind(id)
        .bind(id)
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await
        .unwrap();
    }

    async fn seed_owned_graph(db: &Db, user_id: &str, suffix: &str) {
        let now = Utc::now().to_rfc3339();
        let repo_id = format!("repo-{suffix}");
        let workspace_id = format!("workspace-{suffix}");
        let run_command_id = format!("run-{suffix}");

        sqlx::query(
            "INSERT INTO repositories (
                id, user_id, name, default_branch, created_at, updated_at, dirty
             ) VALUES (?, ?, ?, 'main', ?, ?, 1)",
        )
        .bind(&repo_id)
        .bind(user_id)
        .bind(format!("Repo {suffix}"))
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO workspaces (
                id, user_id, repository_id, name, command, status, created_at, updated_at, dirty
             ) VALUES (?, ?, ?, ?, 'echo test', 'stopped', ?, ?, 1)",
        )
        .bind(&workspace_id)
        .bind(user_id)
        .bind(&repo_id)
        .bind(format!("Workspace {suffix}"))
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO run_commands (
                id, user_id, repository_id, name, command, created_at, updated_at, dirty
             ) VALUES (?, ?, ?, ?, 'pnpm test', ?, ?, 1)",
        )
        .bind(&run_command_id)
        .bind(user_id)
        .bind(&repo_id)
        .bind(format!("Run {suffix}"))
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await
        .unwrap();
    }

    fn ids(rows: &[sqlx::sqlite::SqliteRow]) -> Vec<String> {
        rows.iter()
            .map(|row| row.try_get::<String, _>("id").unwrap())
            .collect()
    }

    #[tokio::test]
    async fn dirty_row_queries_only_return_active_user_rows() {
        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_user(&db, "user-b").await;
        seed_owned_graph(&db, "user-a", "a").await;
        seed_owned_graph(&db, "user-b", "b").await;

        assert_eq!(
            ids(&dirty_repository_rows(&db, "user-b").await.unwrap()),
            vec!["repo-b"]
        );
        assert_eq!(
            ids(&dirty_workspace_rows(&db, "user-b").await.unwrap()),
            vec!["workspace-b"]
        );
        assert_eq!(
            ids(&dirty_run_command_rows(&db, "user-b").await.unwrap()),
            vec!["run-b"]
        );

        let repo_ids = local_repository_ids(&db, "user-b").await.unwrap();
        assert!(repo_ids.contains("repo-b"));
        assert!(!repo_ids.contains("repo-a"));
    }

    #[tokio::test]
    async fn cloud_pulls_stamp_rows_with_active_user() {
        let db = fresh_db().await;
        insert_user(&db, "user-b").await;
        let client = test_client("user-b");
        let now = Utc::now();

        upsert_repository_from_cloud(
            &client,
            &db,
            &CloudRepositoryRow {
                id: "repo-cloud".into(),
                name: "Cloud Repo".into(),
                remote_url: None,
                local_paths: HashMap::new(),
                default_branch: "main".into(),
                created_at: now,
                updated_at: now,
                deleted_at: None,
            },
        )
        .await
        .unwrap();

        upsert_workspace_from_cloud(
            &client,
            &db,
            &CloudWorkspaceRow {
                id: "workspace-cloud".into(),
                repository_id: "repo-cloud".into(),
                name: "Cloud Workspace".into(),
                prompt: None,
                agent: Some("claude".into()),
                deleted_at: None,
                command: "echo hi".into(),
                status: "stopped".into(),
                branch: None,
                worktree_path: None,
                exit_code: None,
                created_at: now,
                started_at: None,
                finished_at: None,
                archived_at: None,
                updated_at: now,
                permission_mode: None,
                notify_on_attention: None,
                last_turn_ended_at: None,
                base_branch: None,
                queued_at: None,
                depends_on_workspace_id: None,
                outcome: None,
                outcome_at: None,
                merged_into: None,
                pr_number: None,
                pr_url: None,
                pr_state: None,
            },
        )
        .await
        .unwrap();

        upsert_run_command_from_cloud(
            &client,
            &db,
            &CloudRunCommandRow {
                id: "run-cloud".into(),
                repository_id: "repo-cloud".into(),
                name: "Test".into(),
                command: "pnpm test".into(),
                shortcut: None,
                pinned: false,
                sort_order: 0,
                run_when: None,
                detect_port: None,
                required_for_approve: None,
                created_at: now,
                updated_at: now,
            },
        )
        .await
        .unwrap();

        for (table, id) in [
            ("repositories", "repo-cloud"),
            ("workspaces", "workspace-cloud"),
            ("run_commands", "run-cloud"),
        ] {
            let row = sqlx::query(&format!("SELECT user_id FROM {table} WHERE id = ?"))
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap();
            assert_eq!(row.try_get::<String, _>("user_id").unwrap(), "user-b");
        }

        // The agent enum round-trips from the cloud row onto the local row.
        let agent: Option<String> =
            sqlx::query_scalar("SELECT agent FROM workspaces WHERE id = ?")
                .bind("workspace-cloud")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(agent.as_deref(), Some("claude"));
    }

    // F2: a workspace synced from another machine carries that machine's
    // worktree path. We must NOT store it verbatim (it doesn't exist here);
    // instead derive the local path from the id. Prevents the multi-machine
    // "✗ Failed to start".
    #[tokio::test]
    async fn pull_derives_local_worktree_path_and_ignores_cloud_value() {
        let db = fresh_db().await;
        insert_user(&db, "user-b").await;
        insert_repo(&db, "repo-1", "user-b", 0).await;
        let client = test_client("user-b");
        let now = Utc::now();

        let foreign_path = "/other/machine/.phasr/worktrees/ws-1";
        upsert_workspace_from_cloud(
            &client,
            &db,
            &CloudWorkspaceRow {
                id: "ws-1".into(),
                repository_id: "repo-1".into(),
                name: "W".into(),
                prompt: None,
                agent: Some("claude".into()),
                deleted_at: None,
                command: "echo".into(),
                status: "stopped".into(),
                branch: Some("phasr/abc".into()),
                worktree_path: Some(foreign_path.into()),
                exit_code: None,
                created_at: now,
                started_at: None,
                finished_at: None,
                archived_at: None,
                updated_at: now,
                permission_mode: None,
                notify_on_attention: None,
                last_turn_ended_at: None,
                base_branch: None,
                queued_at: None,
                depends_on_workspace_id: None,
                outcome: None,
                outcome_at: None,
                merged_into: None,
                pr_number: None,
                pr_url: None,
                pr_state: None,
            },
        )
        .await
        .unwrap();

        let stored: Option<String> =
            sqlx::query_scalar("SELECT worktree_path FROM workspaces WHERE id = ?")
                .bind("ws-1")
                .fetch_one(&db)
                .await
                .unwrap();
        let expected = crate::git::default_worktree_base_path()
            .join("ws-1")
            .to_string_lossy()
            .into_owned();
        assert_eq!(stored.as_deref(), Some(expected.as_str()));
        assert_ne!(stored.as_deref(), Some(foreign_path));
    }

    // A branch-less cloud workspace (never had a worktree) stays NULL —
    // deriving a path for it would trigger a doomed self-heal on open.
    #[tokio::test]
    async fn pull_leaves_worktree_path_null_when_no_branch() {
        let db = fresh_db().await;
        insert_user(&db, "user-b").await;
        insert_repo(&db, "repo-1", "user-b", 0).await;
        let client = test_client("user-b");
        let now = Utc::now();

        upsert_workspace_from_cloud(
            &client,
            &db,
            &CloudWorkspaceRow {
                id: "ws-2".into(),
                repository_id: "repo-1".into(),
                name: "W".into(),
                prompt: None,
                agent: None,
                deleted_at: None,
                command: "echo".into(),
                status: "stopped".into(),
                branch: None,
                worktree_path: Some("/other/machine/x".into()),
                exit_code: None,
                created_at: now,
                started_at: None,
                finished_at: None,
                archived_at: None,
                updated_at: now,
                permission_mode: None,
                notify_on_attention: None,
                last_turn_ended_at: None,
                base_branch: None,
                queued_at: None,
                depends_on_workspace_id: None,
                outcome: None,
                outcome_at: None,
                merged_into: None,
                pr_number: None,
                pr_url: None,
                pr_state: None,
            },
        )
        .await
        .unwrap();

        let stored: Option<String> =
            sqlx::query_scalar("SELECT worktree_path FROM workspaces WHERE id = ?")
                .bind("ws-2")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(stored, None);
    }

    fn cloud_ws(id: &str, branch: Option<&str>, updated_at: DateTime<Utc>) -> CloudWorkspaceRow {
        CloudWorkspaceRow {
            id: id.into(),
            repository_id: "repo-1".into(),
            name: "W".into(),
            prompt: None,
            agent: Some("claude".into()),
            deleted_at: None,
            command: "echo".into(),
            status: "stopped".into(),
            branch: branch.map(str::to_string),
            worktree_path: Some("/other/machine/wt".into()),
            exit_code: None,
            created_at: updated_at,
            started_at: None,
            finished_at: None,
            archived_at: None,
            updated_at,
            permission_mode: None,
            notify_on_attention: None,
            last_turn_ended_at: None,
            base_branch: None,
            queued_at: None,
            depends_on_workspace_id: None,
            outcome: None,
            outcome_at: None,
            merged_into: None,
            pr_number: None,
            pr_url: None,
            pr_state: None,
        }
    }

    // M11: a new row is derived under this machine's resolved worktree base
    // (repository override here); an existing row whose worktree is on disk
    // keeps it even after the base setting moved; one whose dir is gone is
    // re-derived.
    #[tokio::test]
    async fn pull_derives_under_the_resolved_base_and_keeps_an_existing_local_path() {
        let db = fresh_db().await;
        insert_user(&db, "user-b").await;
        insert_repo(&db, "repo-1", "user-b", 0).await;
        let client = test_client("user-b");
        let stored = |db: Db, id: &'static str| async move {
            sqlx::query_scalar::<_, Option<String>>("SELECT worktree_path FROM workspaces WHERE id = ?")
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap()
        };
        let base = tempfile::tempdir().unwrap();
        let configs = crate::store::RepositoryConfigRepo::new(db.clone());
        let mut cfg = configs.get("repo-1").await.unwrap();
        cfg.worktree_base_path = Some(base.path().to_string_lossy().into_owned());
        configs.upsert(&cfg, None).await.unwrap();

        let t0 = Utc::now() - chrono::Duration::minutes(10);
        upsert_workspace_from_cloud(&client, &db, &cloud_ws("ws-new", Some("phasr/x"), t0))
            .await
            .unwrap();
        let derived = base.path().join("ws-new").to_string_lossy().into_owned();
        assert_eq!(stored(db.clone(), "ws-new").await.as_deref(), Some(derived.as_str()));

        // The worktree exists on disk; then the base setting moves.
        std::fs::create_dir_all(&derived).unwrap();
        cfg.worktree_base_path = Some("/somewhere/else".into());
        configs.upsert(&cfg, None).await.unwrap();
        upsert_workspace_from_cloud(
            &client,
            &db,
            &cloud_ws("ws-new", Some("phasr/x"), t0 + chrono::Duration::minutes(1)),
        )
        .await
        .unwrap();
        assert_eq!(stored(db.clone(), "ws-new").await.as_deref(), Some(derived.as_str()), "kept");

        // Gone from disk → re-derived under the current base.
        std::fs::remove_dir_all(&derived).unwrap();
        upsert_workspace_from_cloud(
            &client,
            &db,
            &cloud_ws("ws-new", Some("phasr/x"), t0 + chrono::Duration::minutes(2)),
        )
        .await
        .unwrap();
        assert_eq!(stored(db.clone(), "ws-new").await.as_deref(), Some("/somewhere/else/ws-new"));
    }

    // F2 push: the local (machine-specific) worktree path must never leave
    // this machine — it goes to the cloud as NULL.
    #[tokio::test]
    async fn push_workspace_sends_null_worktree_path() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-b").await;
        insert_repo(&db, "repo-1", "user-b", 0).await;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO workspaces (
                id, user_id, repository_id, workspace_kind, name, command, status,
                branch, worktree_path, created_at, updated_at, dirty
             ) VALUES (?, ?, ?, 'agent', 'W', 'echo', 'stopped', ?, ?, ?, ?, 1)",
        )
        .bind("ws-push")
        .bind("user-b")
        .bind("repo-1")
        .bind("phasr/abc")
        .bind("/local/machine/.phasr/worktrees/ws-push")
        .bind(&now)
        .bind(&now)
        .execute(&db)
        .await
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/workspaces"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        let client = client_at("user-b", &server.uri());

        push_dirty_workspaces(&client, &db).await.unwrap();

        let received = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&received[0].body).unwrap();
        // Upserts post a single-object body.
        assert_eq!(body["worktree_path"], Value::Null);
        assert_eq!(body["branch"], "phasr/abc");
    }

    // 0015: the permission-mode columns travel with the workspace row.
    #[tokio::test]
    async fn push_workspace_sends_permission_mode_and_notify() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-new", "user-a", "repo-a", "claude").await;
        insert_agent_workspace(&db, "ws-legacy", "user-a", "repo-a", "codex").await;
        sqlx::query(
            "UPDATE workspaces SET permission_mode = 'ask-shell', notify_on_attention = 0
             WHERE id = 'ws-new'",
        )
        .execute(&db)
        .await
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/workspaces"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        let client = client_at("user-a", &server.uri());
        push_dirty_workspaces(&client, &db).await.unwrap();

        let bodies: Vec<Value> = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .collect();
        let body_for = |id: &str| bodies.iter().find(|b| b["id"] == id).unwrap().clone();

        let new = body_for("ws-new");
        assert_eq!(new["permission_mode"], "ask-shell");
        assert_eq!(new["notify_on_attention"], false);
        // A pre-0015 row goes up as an explicit NULL (= legacy skip-all),
        // with the column default for notify.
        let legacy = body_for("ws-legacy");
        assert!(legacy.get("permission_mode").is_some_and(Value::is_null));
        assert_eq!(legacy["notify_on_attention"], true);
    }

    fn cloud_workspace(id: &str, updated_at: DateTime<Utc>) -> CloudWorkspaceRow {
        CloudWorkspaceRow {
            id: id.into(),
            repository_id: "repo-a".into(),
            name: "W".into(),
            prompt: None,
            agent: Some("claude".into()),
            deleted_at: None,
            command: "claude".into(),
            status: "stopped".into(),
            branch: None,
            worktree_path: None,
            exit_code: None,
            created_at: updated_at,
            started_at: None,
            finished_at: None,
            archived_at: None,
            updated_at,
            permission_mode: None,
            notify_on_attention: None,
            last_turn_ended_at: None,
            base_branch: None,
            queued_at: None,
            depends_on_workspace_id: None,
            outcome: None,
            outcome_at: None,
            merged_into: None,
            pr_number: None,
            pr_url: None,
            pr_state: None,
        }
    }

    async fn local_mode(db: &Db, id: &str) -> (Option<String>, i64) {
        sqlx::query_as("SELECT permission_mode, notify_on_attention FROM workspaces WHERE id = ?")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap()
    }

    /// Pull writes the new columns when the cloud has them, and leaves the
    /// local values alone when the payload predates cloud migration 0010.
    #[tokio::test]
    async fn pull_workspace_applies_permission_columns_only_when_present() {
        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        let client = test_client("user-a");
        let t0 = Utc::now() - chrono::Duration::minutes(10);

        // Insert from a cloud row that carries the columns.
        let mut row = cloud_workspace("ws-c", t0);
        row.permission_mode = Some(Some("ask-edits".into()));
        row.notify_on_attention = Some(false);
        upsert_workspace_from_cloud(&client, &db, &row).await.unwrap();
        assert_eq!(local_mode(&db, "ws-c").await, (Some("ask-edits".into()), 0));

        // A newer cloud row WITHOUT the columns (cloud not migrated): local
        // values survive.
        let row = cloud_workspace("ws-c", t0 + chrono::Duration::minutes(1));
        upsert_workspace_from_cloud(&client, &db, &row).await.unwrap();
        assert_eq!(local_mode(&db, "ws-c").await, (Some("ask-edits".into()), 0));

        // An explicit NULL is applied (legacy skip-all row).
        let mut row = cloud_workspace("ws-c", t0 + chrono::Duration::minutes(2));
        row.permission_mode = Some(None);
        row.notify_on_attention = Some(true);
        upsert_workspace_from_cloud(&client, &db, &row).await.unwrap();
        assert_eq!(local_mode(&db, "ws-c").await, (None, 1));

        // An insert from a pre-0010 payload takes the local defaults.
        upsert_workspace_from_cloud(&client, &db, &cloud_workspace("ws-old", t0))
            .await
            .unwrap();
        assert_eq!(local_mode(&db, "ws-old").await, (None, 1));
    }

    // 0016: `last_turn_ended_at` travels both ways; `agent_session_id` is
    // machine-local and must never reach the cloud nor be cleared by a pull.
    #[tokio::test]
    async fn last_turn_ended_at_syncs_and_agent_session_id_stays_local() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-t", "user-a", "repo-a", "claude").await;
        sqlx::query(
            "UPDATE workspaces SET last_turn_ended_at = '2026-11-09T10:00:00+00:00',
                    agent_session_id = 'local-session'
             WHERE id = 'ws-t'",
        )
        .execute(&db)
        .await
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/workspaces"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        let client = client_at("user-a", &server.uri());
        push_dirty_workspaces(&client, &db).await.unwrap();
        let received = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&received[0].body).unwrap();
        assert_eq!(body["last_turn_ended_at"], "2026-11-09T10:00:00+00:00");
        assert!(body.get("agent_session_id").is_none());

        let read = |db: Db| async move {
            sqlx::query_as::<_, (Option<String>, Option<String>)>(
                "SELECT last_turn_ended_at, agent_session_id FROM workspaces WHERE id = 'ws-t'",
            )
            .fetch_one(&db)
            .await
            .unwrap()
        };
        let later = Utc::now() + chrono::Duration::minutes(5);

        // A newer cloud row from an unmigrated cloud (column absent) keeps
        // the local value; the session id survives every pull.
        let mut row = cloud_workspace("ws-t", later);
        row.repository_id = "repo-a".into();
        upsert_workspace_from_cloud(&client, &db, &row).await.unwrap();
        let (ended, session) = read(db.clone()).await;
        assert!(ended.is_some_and(|e| e.starts_with("2026-11-09T10:00:00")));
        assert_eq!(session.as_deref(), Some("local-session"));

        // A present value is applied.
        let mut row = cloud_workspace("ws-t", later + chrono::Duration::minutes(1));
        let other = Utc::now();
        row.last_turn_ended_at = Some(Some(other));
        upsert_workspace_from_cloud(&client, &db, &row).await.unwrap();
        let (ended, session) = read(db.clone()).await;
        assert_eq!(ended, Some(other.to_rfc3339()));
        assert_eq!(session.as_deref(), Some("local-session"));
    }

    // 0017: the board columns travel both ways.
    #[tokio::test]
    async fn board_columns_sync_both_ways() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-b", "user-a", "repo-a", "claude").await;
        insert_agent_workspace(&db, "ws-plain", "user-a", "repo-a", "codex").await;
        sqlx::query(
            "UPDATE workspaces SET base_branch = 'develop', queued_at = '2026-11-09T09:00:00+00:00',
                    depends_on_workspace_id = 'ws-plain', outcome = 'merged',
                    outcome_at = '2026-11-09T11:00:00+00:00', merged_into = 'main',
                    pr_number = 142, pr_url = 'https://github.com/o/r/pull/142', pr_state = 'merged'
             WHERE id = 'ws-b'",
        )
        .execute(&db)
        .await
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/workspaces"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        let client = client_at("user-a", &server.uri());
        push_dirty_workspaces(&client, &db).await.unwrap();
        let bodies: Vec<Value> = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .collect();
        let body = bodies.iter().find(|b| b["id"] == "ws-b").unwrap();
        assert_eq!(body["base_branch"], "develop");
        assert_eq!(body["queued_at"], "2026-11-09T09:00:00+00:00");
        assert_eq!(body["depends_on_workspace_id"], "ws-plain");
        assert_eq!(body["outcome"], "merged");
        assert_eq!(body["outcome_at"], "2026-11-09T11:00:00+00:00");
        assert_eq!(body["merged_into"], "main");
        assert_eq!(body["pr_number"], 142);
        assert_eq!(body["pr_url"], "https://github.com/o/r/pull/142");
        assert_eq!(body["pr_state"], "merged");
        // Unset columns go up as explicit NULLs, not missing keys.
        let plain = bodies.iter().find(|b| b["id"] == "ws-plain").unwrap();
        for key in ["base_branch", "queued_at", "depends_on_workspace_id", "outcome", "pr_number"] {
            assert!(plain.get(key).is_some_and(Value::is_null), "{key}");
        }

        let read = |db: Db| async move {
            sqlx::query_as::<_, (Option<String>, Option<String>, Option<i64>)>(
                "SELECT base_branch, outcome, pr_number FROM workspaces WHERE id = 'ws-b'",
            )
            .fetch_one(&db)
            .await
            .unwrap()
        };
        // A newer cloud row from an unmigrated cloud (columns absent)
        // keeps every local value.
        let later = Utc::now() + chrono::Duration::minutes(5);
        upsert_workspace_from_cloud(&client, &db, &cloud_workspace("ws-b", later))
            .await
            .unwrap();
        assert_eq!(
            read(db.clone()).await,
            (Some("develop".into()), Some("merged".into()), Some(142))
        );
        // Present values (including an explicit NULL) are applied.
        let mut row = cloud_workspace("ws-b", later + chrono::Duration::minutes(1));
        row.base_branch = Some(Some("main".into()));
        row.outcome = Some(None);
        row.pr_number = Some(Some(7));
        upsert_workspace_from_cloud(&client, &db, &row).await.unwrap();
        assert_eq!(read(db.clone()).await, (Some("main".into()), None, Some(7)));
        // And on insert.
        let mut row = cloud_workspace("ws-new", later);
        row.queued_at = Some(Some(later));
        row.depends_on_workspace_id = Some(Some("ws-b".into()));
        upsert_workspace_from_cloud(&client, &db, &row).await.unwrap();
        let (queued, dep): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT queued_at, depends_on_workspace_id FROM workspaces WHERE id = 'ws-new'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(queued, Some(later.to_rfc3339()));
        assert_eq!(dep.as_deref(), Some("ws-b"));
    }

    /// Absent vs null must survive JSON decoding, not just struct literals.
    #[test]
    fn cloud_workspace_row_distinguishes_absent_from_null() {
        let base = serde_json::json!({
            "id": "w", "repository_id": "r", "name": "n", "prompt": null,
            "command": "c", "status": "stopped", "branch": null, "worktree_path": null,
            "exit_code": null, "created_at": "2026-01-01T00:00:00Z", "started_at": null,
            "finished_at": null, "archived_at": null, "updated_at": "2026-01-01T00:00:00Z",
        });
        let absent: CloudWorkspaceRow = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(absent.permission_mode, None);
        assert_eq!(absent.notify_on_attention, None);

        let mut with_null = base.clone();
        with_null["permission_mode"] = Value::Null;
        let parsed: CloudWorkspaceRow = serde_json::from_value(with_null).unwrap();
        assert_eq!(parsed.permission_mode, Some(None));

        let mut with_value = base;
        with_value["permission_mode"] = "skip-all".into();
        with_value["notify_on_attention"] = false.into();
        let parsed: CloudWorkspaceRow = serde_json::from_value(with_value).unwrap();
        assert_eq!(parsed.permission_mode, Some(Some("skip-all".into())));
        assert_eq!(parsed.notify_on_attention, Some(false));
    }

    #[tokio::test]
    async fn push_user_settings_sends_permission_mode_and_agent_commands() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        get_or_init_user_settings(&db, "user-a").await.unwrap();
        sqlx::query(
            "UPDATE user_settings SET default_permission_mode = 'ask-edits',
                agent_commands = '{\"claude\":\"claude --x {{permissions}}\"}', dirty = 1
             WHERE id = 1",
        )
        .execute(&db)
        .await
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        let client = client_at("user-a", &server.uri());
        push_dirty_user_settings(&client, &db).await.unwrap();

        let received = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&received[0].body).unwrap();
        assert_eq!(body["default_permission_mode"], "ask-edits");
        // jsonb in the cloud: an object, not a string.
        assert_eq!(body["agent_commands"]["claude"], "claude --x {{permissions}}");
    }

    #[tokio::test]
    async fn pull_user_settings_applies_new_columns_only_when_present() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        get_or_init_user_settings(&db, "user-a").await.unwrap();
        sqlx::query(
            "UPDATE user_settings SET default_permission_mode = 'skip-all',
                agent_commands = '{\"codex\":\"codex {{permissions}}\"}',
                updated_at = '2026-01-01T00:00:00Z'
             WHERE id = 1",
        )
        .execute(&db)
        .await
        .unwrap();

        let cloud = |extra: Value| {
            // Cloud rows are snake_case; built from the local defaults.
            let d = UserSettings::default();
            let mut row = serde_json::json!({
                "theme": "light", "accent_color": d.accent_color, "sans_font": d.sans_font,
                "mono_font": d.mono_font, "base_font_size": d.base_font_size,
                "cursor_style": d.cursor_style, "cursor_blink": d.cursor_blink,
                "terminal_scrollback": d.terminal_scrollback, "default_editor": d.default_editor,
                "default_terminal": d.default_terminal, "keyboard_shortcuts": {},
                "branch_prefix_template": d.branch_prefix_template,
                "worktree_base_path": d.worktree_base_path,
                "default_merge_strategy": d.default_merge_strategy,
                "auto_fetch_seconds": d.auto_fetch_seconds, "honor_gpg_sign": d.honor_gpg_sign,
                "auto_push_on_commit": d.auto_push_on_commit,
                "updated_at": "2026-06-01T00:00:00Z",
            });
            for (k, v) in extra.as_object().unwrap() {
                row[k] = v.clone();
            }
            serde_json::json!([row])
        };
        let read = |db: Db| async move {
            sqlx::query_as::<_, (String, String, String)>(
                "SELECT theme, default_permission_mode, agent_commands FROM user_settings WHERE id = 1",
            )
            .fetch_one(&db)
            .await
            .unwrap()
        };

        // Pre-0010 cloud row: theme applies, the new local values survive.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(cloud(serde_json::json!({}))))
            .mount(&server)
            .await;
        pull_user_settings(&client_at("user-a", &server.uri()), &db)
            .await
            .unwrap();
        let (theme, mode, commands) = read(db.clone()).await;
        assert_eq!(theme, "light");
        assert_eq!(mode, "skip-all");
        assert_eq!(commands, r#"{"codex":"codex {{permissions}}"}"#);

        // Migrated cloud row: the new columns apply.
        sqlx::query("UPDATE user_settings SET updated_at = '2026-01-01T00:00:00Z' WHERE id = 1")
            .execute(&db)
            .await
            .unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(cloud(serde_json::json!({
                "default_permission_mode": "ask-edits",
                "agent_commands": {"gemini": "gemini {{permissions}}"},
            }))))
            .mount(&server)
            .await;
        pull_user_settings(&client_at("user-a", &server.uri()), &db)
            .await
            .unwrap();
        let (_, mode, commands) = read(db.clone()).await;
        assert_eq!(mode, "ask-edits");
        assert_eq!(commands, r#"{"gemini":"gemini {{permissions}}"}"#);
    }

    #[tokio::test]
    async fn user_settings_sync_does_not_claim_another_users_singleton() {
        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_user(&db, "user-b").await;
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO user_settings (
                id, user_id, updated_at, synced_at, dirty
             ) VALUES (1, ?, ?, NULL, 1)",
        )
        .bind("user-a")
        .bind(&now)
        .execute(&db)
        .await
        .unwrap();

        assert!(get_or_init_user_settings(&db, "user-b")
            .await
            .unwrap()
            .is_none());
        assert!(get_or_init_user_settings(&db, "user-a")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn user_settings_sync_initializes_owned_singleton() {
        let db = fresh_db().await;
        insert_user(&db, "user-b").await;

        assert!(get_or_init_user_settings(&db, "user-b")
            .await
            .unwrap()
            .is_some());

        let row = sqlx::query("SELECT user_id FROM user_settings WHERE id = 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(row.try_get::<String, _>("user_id").unwrap(), "user-b");
    }

    // ── HTTP sync round-trip tests (mock Supabase via wiremock) ──────────
    // These exercise the real push/pull code paths against a stubbed
    // PostgREST so the agent round-trip and sync resilience are guarded.

    #[tokio::test]
    async fn push_workspace_sends_agent_and_marks_synced() {
        use wiremock::matchers::{body_string_contains, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-a", "user-a", "repo-a", "claude").await;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/workspaces"))
            .and(body_string_contains(r#""agent":"claude""#))
            .and(body_string_contains(r#""repository_id":"repo-a""#))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;

        let client = client_at("user-a", &server.uri());
        push_dirty_workspaces(&client, &db).await.unwrap();

        // mark_synced runs only after a successful upsert.
        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM workspaces WHERE id = 'ws-a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(dirty, 0);
        // `expect(1)` is verified when `server` drops at end of scope.
    }

    #[tokio::test]
    async fn pull_workspace_writes_agent() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        // Pull only applies rows whose repository exists locally.
        insert_repo(&db, "repo-a", "user-a", 0).await;

        let now = Utc::now().to_rfc3339();
        let body = serde_json::json!([{
            "id": "ws-cloud",
            "repository_id": "repo-a",
            "name": "Cloud WS",
            "prompt": null,
            "agent": "codex",
            "command": "codex",
            "status": "stopped",
            "branch": null,
            "worktree_path": null,
            "exit_code": null,
            "created_at": now,
            "started_at": null,
            "finished_at": null,
            "archived_at": null,
            "updated_at": now,
        }]);

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/v1/workspaces"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = client_at("user-a", &server.uri());
        pull_workspaces(&client, &db).await.unwrap();

        let agent: Option<String> =
            sqlx::query_scalar("SELECT agent FROM workspaces WHERE id = 'ws-cloud'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(agent.as_deref(), Some("codex"));
    }

    #[tokio::test]
    async fn sync_once_pushes_workspace_even_when_an_earlier_step_fails() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await; // already synced → not pushed
        insert_agent_workspace(&db, "ws-a", "user-a", "repo-a", "claude").await;

        let server = MockServer::start().await;
        // Specific mocks first — wiremock returns the first mounted match.
        // An earlier pull step fails hard…
        Mock::given(method("GET"))
            .and(path("/rest/v1/repositories"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        // …but the dirty workspace must still be pushed.
        Mock::given(method("POST"))
            .and(path("/rest/v1/workspaces"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        // Catch-alls last for every other GET/POST the cycle makes.
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let client = client_at("user-a", &server.uri());
        let result = sync_once(&client, &db).await;

        // The first error is still surfaced…
        assert!(result.is_err());
        // …yet the workspace push happened anyway (resilience fix).
        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM workspaces WHERE id = 'ws-a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(dirty, 0);
    }

    #[tokio::test]
    async fn request_sync_signals_the_worker() {
        let state = CloudSyncState::default();
        // notify_one parks a permit even with no waiter yet…
        state.request_sync();
        // …which the worker's next `notified()` consumes immediately.
        tokio::time::timeout(Duration::from_millis(100), state.trigger.notified())
            .await
            .expect("request_sync should wake a waiter");
    }

    #[tokio::test]
    async fn push_repository_delete_soft_deletes_in_cloud() {
        use wiremock::matchers::{body_string_contains, method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 1).await;
        let now = Utc::now().to_rfc3339();
        sqlx::query("UPDATE repositories SET deleted_at = ?, dirty = 1 WHERE id = 'repo-a'")
            .bind(&now)
            .execute(&db)
            .await
            .unwrap();

        let server = MockServer::start().await;
        // A hard DELETE would be the old, wrong behavior.
        Mock::given(method("DELETE"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/rest/v1/repositories"))
            .and(query_param("id", "eq.repo-a"))
            .and(body_string_contains("deleted_at"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let client = client_at("user-a", &server.uri());
        push_repository_deletes(&client, &db).await.unwrap();

        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM repositories WHERE id = 'repo-a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(dirty, 0);
    }

    #[tokio::test]
    async fn pull_cloud_tombstone_soft_deletes_local_repo_and_children() {
        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-a", "user-a", "repo-a", "claude").await;

        // No HTTP in the tombstone path, so the dummy URL is never hit.
        let client = client_at("user-a", "http://127.0.0.1:1");
        let now = Utc::now();
        upsert_repository_from_cloud(
            &client,
            &db,
            &CloudRepositoryRow {
                id: "repo-a".into(),
                name: "R".into(),
                remote_url: None,
                local_paths: HashMap::new(),
                default_branch: "main".into(),
                created_at: now,
                updated_at: now,
                deleted_at: Some(now),
            },
        )
        .await
        .unwrap();

        // Local repo is tombstoned (hidden) and its child workspace is gone.
        let live: Option<String> =
            sqlx::query_scalar("SELECT id FROM repositories WHERE id='repo-a' AND deleted_at IS NULL")
                .fetch_optional(&db)
                .await
                .unwrap();
        assert!(live.is_none());
        let tomb: Option<String> = sqlx::query_scalar(
            "SELECT id FROM repositories WHERE id='repo-a' AND deleted_at IS NOT NULL",
        )
        .fetch_optional(&db)
        .await
        .unwrap();
        assert!(tomb.is_some());
        let ws_count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE id='ws-a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(ws_count, 0);
    }

    #[tokio::test]
    async fn pull_cloud_tombstone_leaves_notes_live_and_hard_deletes_other_children() {
        use crate::domain::{Note, NoteOriginKind};
        use crate::store::NoteRepo;

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-a", "user-a", "repo-a", "claude").await;

        let notes = NoteRepo::new(db.clone());
        let mut n = Note::new("repo-a".into(), "keep me".into(), NoteOriginKind::Repository);
        n.origin_label = "Repository home".into();
        notes.insert_for_user(&n, "user-a").await.unwrap();

        let client = client_at("user-a", "http://127.0.0.1:1");
        let now = Utc::now();
        upsert_repository_from_cloud(
            &client,
            &db,
            &CloudRepositoryRow {
                id: "repo-a".into(),
                name: "R".into(),
                remote_url: None,
                local_paths: HashMap::new(),
                default_branch: "main".into(),
                created_at: now,
                updated_at: now,
                deleted_at: Some(now),
            },
        )
        .await
        .unwrap();

        // The note is untouched — a repository removal arriving from
        // another device must not destroy the user's todos either.
        let deleted_at: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM repository_notes WHERE id = ?")
                .bind(&n.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(deleted_at.is_none(), "note must stay live after a cloud tombstone");

        // The workspace child is hard-deleted, unchanged policy.
        let ws_count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE id='ws-a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(ws_count, 0);
    }

    #[tokio::test]
    async fn push_workspace_delete_soft_deletes_in_cloud() {
        use wiremock::matchers::{body_string_contains, method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-a", "user-a", "repo-a", "claude").await;
        let now = Utc::now().to_rfc3339();
        sqlx::query("UPDATE workspaces SET deleted_at = ?, dirty = 1 WHERE id = 'ws-a'")
            .bind(&now)
            .execute(&db)
            .await
            .unwrap();

        let server = MockServer::start().await;
        // A hard DELETE would be the old, wrong behavior.
        Mock::given(method("DELETE"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/rest/v1/workspaces"))
            .and(query_param("id", "eq.ws-a"))
            .and(body_string_contains("deleted_at"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let client = client_at("user-a", &server.uri());
        push_workspace_deletes(&client, &db).await.unwrap();

        let dirty: i64 = sqlx::query_scalar("SELECT dirty FROM workspaces WHERE id = 'ws-a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(dirty, 0);
    }

    #[tokio::test]
    async fn pull_cloud_tombstone_does_not_resurrect_workspace() {
        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-a", "user-a", "repo-a", "claude").await;

        // Cloud row says deleted — pulling must tombstone the live local
        // row, not keep/resurrect it.
        let client = client_at("user-a", "http://127.0.0.1:1");
        let now = Utc::now();
        upsert_workspace_from_cloud(
            &client,
            &db,
            &CloudWorkspaceRow {
                id: "ws-a".into(),
                repository_id: "repo-a".into(),
                name: "W".into(),
                prompt: None,
                agent: Some("claude".into()),
                deleted_at: Some(now),
                command: "run".into(),
                status: "stopped".into(),
                branch: None,
                worktree_path: None,
                exit_code: None,
                created_at: now,
                started_at: None,
                finished_at: None,
                archived_at: None,
                updated_at: now,
                permission_mode: None,
                notify_on_attention: None,
                last_turn_ended_at: None,
                base_branch: None,
                queued_at: None,
                depends_on_workspace_id: None,
                outcome: None,
                outcome_at: None,
                merged_into: None,
                pr_number: None,
                pr_url: None,
                pr_state: None,
            },
        )
        .await
        .unwrap();

        let live: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM workspaces WHERE id='ws-a' AND deleted_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(live, 0);
    }

    // Backward-compat: if the cloud tombstone hasn't landed yet (cloud
    // migration not applied / push failed), the cloud still reports the
    // workspace LIVE. A pull must NOT resurrect a row we soft-deleted
    // locally, and must leave it dirty so the tombstone can still push.
    #[tokio::test]
    async fn pull_does_not_resurrect_locally_deleted_workspace() {
        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        insert_agent_workspace(&db, "ws-a", "user-a", "repo-a", "claude").await;
        let now = Utc::now().to_rfc3339();
        sqlx::query("UPDATE workspaces SET deleted_at = ?, dirty = 1 WHERE id = 'ws-a'")
            .bind(&now)
            .execute(&db)
            .await
            .unwrap();

        let client = client_at("user-a", "http://127.0.0.1:1");
        let now_dt = Utc::now();
        upsert_workspace_from_cloud(
            &client,
            &db,
            &CloudWorkspaceRow {
                id: "ws-a".into(),
                repository_id: "repo-a".into(),
                name: "W".into(),
                prompt: None,
                agent: Some("claude".into()),
                deleted_at: None, // cloud still thinks it's live
                command: "run".into(),
                status: "stopped".into(),
                branch: None,
                worktree_path: None,
                exit_code: None,
                created_at: now_dt,
                started_at: None,
                finished_at: None,
                archived_at: None,
                updated_at: now_dt,
                permission_mode: None,
                notify_on_attention: None,
                last_turn_ended_at: None,
                base_branch: None,
                queued_at: None,
                depends_on_workspace_id: None,
                outcome: None,
                outcome_at: None,
                merged_into: None,
                pr_number: None,
                pr_url: None,
                pr_state: None,
            },
        )
        .await
        .unwrap();

        let row = sqlx::query(
            "SELECT (deleted_at IS NULL) AS live, dirty FROM workspaces WHERE id = 'ws-a'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(row.try_get::<i64, _>("live").unwrap(), 0); // still tombstoned
        assert_eq!(row.try_get::<i64, _>("dirty").unwrap(), 1); // tombstone still pending push
    }

    async fn set_local_path(db: &Db, id: &str, path: &str) {
        sqlx::query("UPDATE repositories SET local_path = ? WHERE id = ?")
            .bind(path)
            .bind(id)
            .execute(db)
            .await
            .unwrap();
    }

    async fn repo_flags(db: &Db, id: &str) -> (i64, Option<String>) {
        let row = sqlx::query("SELECT dirty, local_path FROM repositories WHERE id = ?")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap();
        (
            row.try_get::<i64, _>("dirty").unwrap(),
            row.try_get::<Option<String>, _>("local_path").unwrap(),
        )
    }

    #[tokio::test]
    async fn machine_id_transition_marks_only_pathed_repos_dirty() {
        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "pathed", "user-a", 0).await;
        set_local_path(&db, "pathed", "/tmp/pathed").await;
        insert_repo(&db, "pathless", "user-a", 0).await;

        note_machine_id_transition(&db, "hw-id-1").await.unwrap();
        assert_eq!(repo_flags(&db, "pathed").await.0, 1);
        assert_eq!(repo_flags(&db, "pathless").await.0, 0);

        // Same id again → no-op.
        sqlx::query("UPDATE repositories SET dirty = 0")
            .execute(&db)
            .await
            .unwrap();
        note_machine_id_transition(&db, "hw-id-1").await.unwrap();
        assert_eq!(repo_flags(&db, "pathed").await.0, 0);

        // A NEW id → re-publish again.
        note_machine_id_transition(&db, "hw-id-2").await.unwrap();
        assert_eq!(repo_flags(&db, "pathed").await.0, 1);
    }

    #[tokio::test]
    async fn tombstone_check_sees_null_user_rows() {
        let db = fresh_db().await;
        let now = Utc::now().to_rfc3339();
        // A tombstone written before user_id stamping existed.
        sqlx::query(
            "INSERT INTO repositories (id, name, default_branch, created_at, updated_at, deleted_at, dirty)
             VALUES ('ghost', 'R', 'main', ?, ?, ?, 0)",
        )
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&db)
        .await
        .unwrap();

        assert!(repository_is_soft_deleted(&db, "ghost").await.unwrap());
    }

    #[tokio::test]
    async fn cloud_tombstone_does_not_clobber_dirty_local_row() {
        let db = fresh_db().await;
        let client = test_client("user-a");
        insert_user(&db, "user-a").await;
        // A freshly revived row: live locally, dirty (push pending) —
        // while the cloud still carries the tombstone from before.
        insert_repo(&db, "repo-a", "user-a", 1).await;

        let now_dt = Utc::now();
        upsert_repository_from_cloud(
            &client,
            &db,
            &CloudRepositoryRow {
                id: "repo-a".into(),
                name: "R".into(),
                remote_url: None,
                local_paths: HashMap::new(),
                default_branch: "main".into(),
                created_at: now_dt,
                updated_at: now_dt + chrono::Duration::seconds(60),
                deleted_at: Some(now_dt),
            },
        )
        .await
        .unwrap();

        let live: i64 =
            sqlx::query_scalar("SELECT deleted_at IS NULL FROM repositories WHERE id = 'repo-a'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(live, 1, "a dirty local row must survive a stale cloud tombstone");
    }

    #[tokio::test]
    async fn pull_lands_pathless_when_another_row_owns_the_path() {
        let db = fresh_db().await;
        let client = test_client("user-a");
        insert_user(&db, "user-a").await;
        insert_repo(&db, "local-owner", "user-a", 0).await;
        set_local_path(&db, "local-owner", "/Users/x/code/app").await;

        let now_dt = Utc::now();
        let mut local_paths = HashMap::new();
        local_paths.insert("machine-a".to_string(), "/Users/x/code/app".to_string());
        upsert_repository_from_cloud(
            &client,
            &db,
            &CloudRepositoryRow {
                id: "cloud-dupe".into(),
                name: "R2".into(),
                remote_url: None,
                local_paths,
                default_branch: "main".into(),
                created_at: now_dt,
                updated_at: now_dt,
                deleted_at: None,
            },
        )
        .await
        .unwrap();

        // The incoming row must not steal the folder (or trip the unique
        // active-local_path index) — it lands pathless.
        assert_eq!(repo_flags(&db, "cloud-dupe").await.1, None);
        assert_eq!(
            repo_flags(&db, "local-owner").await.1.as_deref(),
            Some("/Users/x/code/app")
        );
    }

    /// 0018: the review columns travel both ways; an unmigrated cloud (no
    /// columns in the payload) never clears them, and a trigger this build
    /// doesn't know lands as `manual`.
    #[tokio::test]
    async fn run_command_review_columns_sync_both_ways() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        insert_repo(&db, "repo-a", "user-a", 0).await;
        sqlx::query(
            "INSERT INTO run_commands (id, user_id, repository_id, name, command, pinned, sort_order,
                run_when, detect_port, required_for_approve, created_at, updated_at, dirty)
             VALUES ('rc', 'user-a', 'repo-a', 'test', 'pnpm test', 0, 0, 'before_review', 1, 1,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1)",
        )
        .execute(&db)
        .await
        .unwrap();

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/run_commands"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        let client = client_at("user-a", &server.uri());
        push_dirty_run_commands(&client, &db).await.unwrap();
        let received = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&received[0].body).unwrap();
        assert_eq!(body["run_when"], "before_review");
        assert_eq!(body["detect_port"], true);
        assert_eq!(body["required_for_approve"], true);

        let read = |db: Db| async move {
            sqlx::query_as::<_, (String, i64, i64)>(
                "SELECT run_when, detect_port, required_for_approve FROM run_commands WHERE id = 'rc'",
            )
            .fetch_one(&db)
            .await
            .unwrap()
        };
        let newer = |extra: Value| {
            let mut row = json!({
                "id": "rc", "repository_id": "repo-a", "name": "test", "command": "pnpm test",
                "shortcut": null, "pinned": false, "sort_order": 0,
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-06-01T00:00:00Z"
            });
            for (k, v) in extra.as_object().unwrap() {
                row[k] = v.clone();
            }
            serde_json::from_value::<CloudRunCommandRow>(row).unwrap()
        };
        // Unmigrated cloud: columns absent → local values kept.
        upsert_run_command_from_cloud(&client, &db, &newer(json!({}))).await.unwrap();
        assert_eq!(read(db.clone()).await, ("before_review".into(), 1, 1));
        // Migrated cloud: applied; an unknown trigger is stored as manual.
        let mut row = newer(json!({"run_when": "on_merge", "detect_port": false, "required_for_approve": false}));
        row.updated_at = "2026-07-01T00:00:00Z".parse().unwrap();
        upsert_run_command_from_cloud(&client, &db, &row).await.unwrap();
        assert_eq!(read(db.clone()).await, ("manual".into(), 0, 0));
    }

    #[tokio::test]
    async fn notification_prefs_sync_as_jsonb_and_absent_keeps_local() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        get_or_init_user_settings(&db, "user-a").await.unwrap();
        sqlx::query(
            "UPDATE user_settings SET notification_prefs = '{\"backgroundOnly\":false}', dirty = 1,
                updated_at = '2026-01-01T00:00:00Z' WHERE id = 1",
        )
        .execute(&db)
        .await
        .unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        let client = client_at("user-a", &server.uri());
        push_dirty_user_settings(&client, &db).await.unwrap();
        let received = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&received[0].body).unwrap();
        assert_eq!(body["notification_prefs"]["backgroundOnly"], false, "jsonb object, not a string");

        // A newer cloud row WITHOUT the column keeps the local prefs.
        let server = MockServer::start().await;
        let row = json!([{
            "theme": "light", "accent_color": "coral", "sans_font": "Inter", "mono_font": "x",
            "base_font_size": 13, "cursor_style": "block", "cursor_blink": true,
            "terminal_scrollback": 1000, "default_editor": "vscode", "default_terminal": "iterm",
            "keyboard_shortcuts": {}, "branch_prefix_template": "phasr/{{slug}}",
            "worktree_base_path": "~/.phasr/worktrees", "default_merge_strategy": "merge",
            "auto_fetch_seconds": 60, "honor_gpg_sign": true, "auto_push_on_commit": false,
            "updated_at": "2026-06-01T00:00:00Z"
        }]);
        Mock::given(method("GET"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(row))
            .mount(&server)
            .await;
        let client = client_at("user-a", &server.uri());
        pull_user_settings(&client, &db).await.unwrap();
        let prefs: String =
            sqlx::query_scalar("SELECT notification_prefs FROM user_settings WHERE id = 1")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(!NotificationPrefs::from_json(&prefs).background_only);
    }
    #[tokio::test]
    async fn terminal_shell_and_copy_on_select_sync_and_absent_keeps_local() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let db = fresh_db().await;
        insert_user(&db, "user-a").await;
        get_or_init_user_settings(&db, "user-a").await.unwrap();
        sqlx::query(
            "UPDATE user_settings SET terminal_shell = '/bin/zsh', copy_on_select = 1, dirty = 1,
                updated_at = '2026-01-01T00:00:00Z' WHERE id = 1",
        )
        .execute(&db)
        .await
        .unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;
        push_dirty_user_settings(&client_at("user-a", &server.uri()), &db).await.unwrap();
        let received = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&received[0].body).unwrap();
        assert_eq!(body["terminal_shell"], "/bin/zsh");
        assert_eq!(body["copy_on_select"], true, "boolean, not 0/1");

        let base = json!({
            "theme": "light", "accent_color": "coral", "sans_font": "Inter", "mono_font": "x",
            "base_font_size": 13, "cursor_style": "block", "cursor_blink": true,
            "terminal_scrollback": 1000, "default_editor": "vscode", "default_terminal": "iterm",
            "keyboard_shortcuts": {}, "branch_prefix_template": "phasr/{{slug}}",
            "worktree_base_path": "~/.phasr/worktrees", "default_merge_strategy": "merge",
            "auto_fetch_seconds": 60, "honor_gpg_sign": true, "auto_push_on_commit": false,
            "updated_at": "2026-06-01T00:00:00Z"
        });
        let read = |db: Db| async move {
            sqlx::query_as::<_, (String, i64)>(
                "SELECT terminal_shell, copy_on_select FROM user_settings WHERE id = 1",
            )
            .fetch_one(&db)
            .await
            .unwrap()
        };
        // A newer cloud row from an unmigrated cloud keeps the local values…
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([base.clone()])))
            .mount(&server)
            .await;
        pull_user_settings(&client_at("user-a", &server.uri()), &db).await.unwrap();
        assert_eq!(read(db.clone()).await, ("/bin/zsh".into(), 1));

        // …and a migrated one applies.
        let mut migrated = base;
        migrated["terminal_shell"] = json!("/opt/homebrew/bin/fish");
        migrated["copy_on_select"] = json!(false);
        migrated["updated_at"] = json!("2026-07-01T00:00:00Z");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/v1/user_settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([migrated])))
            .mount(&server)
            .await;
        pull_user_settings(&client_at("user-a", &server.uri()), &db).await.unwrap();
        assert_eq!(read(db.clone()).await, ("/opt/homebrew/bin/fish".into(), 0));
    }
}
