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

use crate::auth::{AuthError, SessionState};
use crate::domain::{Repository, UserSettings};
use crate::store::Db;

const SYNC_INTERVAL: Duration = Duration::from_secs(30);

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

#[derive(Default)]
pub struct CloudSyncState {
    handle: Mutex<Option<JoinHandle<()>>>,
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
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCloudSyncInput {
    supabase_url: String,
    supabase_anon_key: String,
    machine_id: String,
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
        if input.machine_id.trim().is_empty() {
            return Err(SyncError::InvalidConfig("missing machine id".into()));
        }
        Ok(Self {
            supabase_url,
            supabase_anon_key: input.supabase_anon_key,
            machine_id: input.machine_id,
        })
    }
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
    let client = SupabaseRestClient::new(config, session.user_id, session.jwt)?;
    let db = db.inner().clone();
    let app_for_loop = app.clone();

    let handle = tauri::async_runtime::spawn(async move {
        loop {
            match sync_once(&client, &db).await {
                Ok(()) => {
                    let _ = app_for_loop.emit("cloud-sync-updated", ());
                }
                Err(err) => {
                    let _ = app_for_loop.emit("cloud-sync-error", err.to_string());
                }
            }
            tokio::time::sleep(SYNC_INTERVAL).await;
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
    push_dirty_users(client, db).await?;
    push_repository_deletes(client, db).await?;
    pull_repositories(client, db).await?;
    push_dirty_repositories(client, db).await?;
    pull_workspaces(client, db).await?;
    push_dirty_workspaces(client, db).await?;
    pull_run_commands(client, db).await?;
    push_dirty_run_commands(client, db).await?;
    pull_user_settings(client, db).await?;
    push_dirty_user_settings(client, db).await?;
    Ok(())
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

    async fn delete_by_id(&self, table: &str, id: &str) -> Result<(), SyncError> {
        let path = format!("/rest/v1/{table}?id=eq.{id}");
        let response = self
            .http
            .delete(self.url(&path))
            .headers(self.headers(false))
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
}

#[derive(Debug, Clone, Deserialize)]
struct CloudWorkspaceRow {
    id: String,
    repository_id: String,
    name: String,
    prompt: Option<String>,
    agent_id: Option<String>,
    command: String,
    status: String,
    branch: Option<String>,
    worktree_path: Option<String>,
    exit_code: Option<i64>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    archived_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
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
    default_agent_id: Option<String>,
    #[serde(default)]
    disabled_agent_ids: Value,
    #[serde(default)]
    keyboard_shortcuts: Value,
    branch_prefix_template: String,
    worktree_base_path: String,
    default_merge_strategy: String,
    auto_fetch_seconds: i64,
    honor_gpg_sign: bool,
    auto_push_on_commit: bool,
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
        "SELECT id FROM repositories
             WHERE deleted_at IS NOT NULL AND dirty = 1 AND user_id = ?",
    )
    .bind(&client.user_id)
    .fetch_all(db)
    .await?;
    for row in rows {
        let id: String = row.try_get("id")?;
        client.delete_by_id("repositories", &id).await?;
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
    if repository_is_soft_deleted(db, &row.id, &client.user_id).await? {
        return Ok(());
    }

    let current = get_repository_row(db, &row.id, &client.user_id).await?;
    let local_path = row
        .local_paths
        .get(&client.config.machine_id)
        .cloned()
        .or_else(|| current.as_ref().and_then(|repo| repo.local_path.clone()));

    if let Some(current) = current {
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
    let current = get_updated_at(db, "workspaces", &row.id, &client.user_id).await?;
    if let Some(current) = current {
        if current >= row.updated_at {
            return Ok(());
        }
        sqlx::query(
            "UPDATE workspaces SET
                user_id = ?, repository_id = ?, name = ?, prompt = ?, agent_id = ?, command = ?, status = ?,
                branch = ?, worktree_path = ?, exit_code = ?,
                created_at = ?, started_at = ?, finished_at = ?, archived_at = ?,
                updated_at = ?, synced_at = ?, dirty = 0
             WHERE id = ?",
        )
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.prompt)
        .bind(&row.agent_id)
        .bind(&row.command)
        .bind(&row.status)
        .bind(&row.branch)
        .bind(&row.worktree_path)
        .bind(row.exit_code)
        .bind(row.created_at.to_rfc3339())
        .bind(row.started_at.map(|dt| dt.to_rfc3339()))
        .bind(row.finished_at.map(|dt| dt.to_rfc3339()))
        .bind(row.archived_at.map(|dt| dt.to_rfc3339()))
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .bind(&row.id)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO workspaces (
                id, user_id, repository_id, name, prompt, agent_id, command, status,
                branch, worktree_path, exit_code,
                created_at, started_at, finished_at, archived_at, updated_at,
                synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(&row.id)
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.prompt)
        .bind(&row.agent_id)
        .bind(&row.command)
        .bind(&row.status)
        .bind(&row.branch)
        .bind(&row.worktree_path)
        .bind(row.exit_code)
        .bind(row.created_at.to_rfc3339())
        .bind(row.started_at.map(|dt| dt.to_rfc3339()))
        .bind(row.finished_at.map(|dt| dt.to_rfc3339()))
        .bind(row.archived_at.map(|dt| dt.to_rfc3339()))
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(db)
        .await?;
    }
    Ok(())
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
                    "agent_id": Value::Null,
                    "command": row.try_get::<String, _>("command")?,
                    "status": row.try_get::<String, _>("status")?,
                    "branch": row.try_get::<Option<String>, _>("branch")?,
                    "worktree_path": row.try_get::<Option<String>, _>("worktree_path")?,
                    "exit_code": row.try_get::<Option<i64>, _>("exit_code")?,
                    "created_at": row.try_get::<String, _>("created_at")?,
                    "started_at": row.try_get::<Option<String>, _>("started_at")?,
                    "finished_at": row.try_get::<Option<String>, _>("finished_at")?,
                    "archived_at": row.try_get::<Option<String>, _>("archived_at")?,
                    "updated_at": row.try_get::<String, _>("updated_at")?,
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
        "SELECT id, repository_id, name, prompt, command, status, branch, worktree_path,
                exit_code, created_at, started_at, finished_at, archived_at, updated_at
         FROM workspaces
         WHERE dirty = 1 AND user_id = ?",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?)
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
                sort_order = ?, created_at = ?, updated_at = ?, synced_at = ?, dirty = 0
             WHERE id = ?",
        )
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.command)
        .bind(&row.shortcut)
        .bind(row.pinned as i64)
        .bind(row.sort_order)
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
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(&row.id)
        .bind(&client.user_id)
        .bind(&row.repository_id)
        .bind(&row.name)
        .bind(&row.command)
        .bind(&row.shortcut)
        .bind(row.pinned as i64)
        .bind(row.sort_order)
        .bind(row.created_at.to_rfc3339())
        .bind(row.updated_at.to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(db)
        .await?;
    }
    Ok(())
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
                created_at, updated_at
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
            default_agent_id = ?, disabled_agent_ids = ?, keyboard_shortcuts = ?,
            branch_prefix_template = ?, worktree_base_path = ?,
            default_merge_strategy = ?, auto_fetch_seconds = ?,
            honor_gpg_sign = ?, auto_push_on_commit = ?,
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
    .bind(&row.default_agent_id)
    .bind(row.disabled_agent_ids.to_string())
    .bind(row.keyboard_shortcuts.to_string())
    .bind(&row.branch_prefix_template)
    .bind(&row.worktree_base_path)
    .bind(&row.default_merge_strategy)
    .bind(row.auto_fetch_seconds)
    .bind(row.honor_gpg_sign as i64)
    .bind(row.auto_push_on_commit as i64)
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
                default_terminal, default_agent_id, disabled_agent_ids,
                keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                default_merge_strategy, auto_fetch_seconds, honor_gpg_sign,
                auto_push_on_commit, updated_at
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
                "default_agent_id": row.try_get::<Option<String>, _>("default_agent_id")?,
                "disabled_agent_ids": parse_json_column(row.try_get("disabled_agent_ids")?)?,
                "keyboard_shortcuts": parse_json_column(row.try_get("keyboard_shortcuts")?)?,
                "branch_prefix_template": row.try_get::<String, _>("branch_prefix_template")?,
                "worktree_base_path": row.try_get::<String, _>("worktree_base_path")?,
                "default_merge_strategy": row.try_get::<String, _>("default_merge_strategy")?,
                "auto_fetch_seconds": row.try_get::<i64, _>("auto_fetch_seconds")?,
                "honor_gpg_sign": row.try_get::<i64, _>("honor_gpg_sign")? != 0,
                "auto_push_on_commit": row.try_get::<i64, _>("auto_push_on_commit")? != 0,
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
                default_terminal, default_agent_id, disabled_agent_ids,
                keyboard_shortcuts, branch_prefix_template, worktree_base_path,
                default_merge_strategy, auto_fetch_seconds, honor_gpg_sign,
                auto_push_on_commit, updated_at
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
            default_agent_id: row.try_get("default_agent_id")?,
            disabled_agent_ids: row.try_get("disabled_agent_ids")?,
            keyboard_shortcuts: row.try_get("keyboard_shortcuts")?,
            branch_prefix_template: row.try_get("branch_prefix_template")?,
            worktree_base_path: row.try_get("worktree_base_path")?,
            default_merge_strategy: row.try_get("default_merge_strategy")?,
            auto_fetch_seconds: row.try_get("auto_fetch_seconds")?,
            honor_gpg_sign: row.try_get::<i64, _>("honor_gpg_sign")? != 0,
            auto_push_on_commit: row.try_get::<i64, _>("auto_push_on_commit")? != 0,
            updated_at: parse_timestamp(row.try_get("updated_at")?, "updated_at")?,
        }));
    }

    let defaults = UserSettings::default();
    sqlx::query(
        "INSERT INTO user_settings (
            id, user_id, theme, accent_color, sans_font, mono_font, base_font_size,
            cursor_style, cursor_blink, terminal_scrollback, default_editor,
            default_terminal, default_agent_id, disabled_agent_ids,
            keyboard_shortcuts, branch_prefix_template, worktree_base_path,
            default_merge_strategy, auto_fetch_seconds, honor_gpg_sign,
            auto_push_on_commit, updated_at, synced_at, dirty
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
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
    .bind(&defaults.default_agent_id)
    .bind(&defaults.disabled_agent_ids)
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

async fn get_repository_row(
    db: &Db,
    id: &str,
    user_id: &str,
) -> Result<Option<Repository>, SyncError> {
    let row = sqlx::query(
        "SELECT id, name, remote_url, local_path, default_branch, created_at, updated_at
         FROM repositories
         WHERE id = ? AND deleted_at IS NULL AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.as_ref().map(repository_from_row).transpose()
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

async fn repository_is_soft_deleted(db: &Db, id: &str, user_id: &str) -> Result<bool, SyncError> {
    let row = sqlx::query(
        "SELECT 1 AS sentinel FROM repositories
         WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(user_id)
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
        SupabaseRestClient::new(
            SyncConfig {
                supabase_url: "http://127.0.0.1:1".into(),
                supabase_anon_key: "anon".into(),
                machine_id: "machine-a".into(),
            },
            user_id.into(),
            "jwt".into(),
        )
        .unwrap()
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
                agent_id: None,
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
}
