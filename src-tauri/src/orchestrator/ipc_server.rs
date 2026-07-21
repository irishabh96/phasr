//! The `phasr` CLI ↔ app IPC server (Story CLI1, architect §R4).
//!
//! A spawned ticket agent advances its OWN board by shelling out to `phasr
//! <verb>` (`bin/phasr_cli.rs`). That CLI is a THIN client: it opens a Unix
//! domain socket at `~/.phasr/phasr.sock` and sends ONE line-delimited JSON
//! request `{ token, verb, args }`. This module is the app-side listener that
//! authenticates the token, dispatches the verb through the SAME `_inner` handler
//! the Tauri command uses, emits `phasr://board-changed` (via the shared
//! `BoardEventBus`) so an open board moves LIVE, and writes back one JSON line.
//!
//! ## Why the app is the single writer (A6 / §R4)
//!
//! The running app owns the SQLite pool, the `TaskRuntime` PTY map, the
//! scheduler's in-flight guards, and the `AppHandle` that emits events. A direct
//! DB write from the CLI would race the pool, fire no events, and desync the
//! in-memory state. So the CLI never touches the DB — it funnels through the app,
//! which reuses the exact command `_inner`s (DRY: `phasr comment` and the UI "Add
//! comment" are identical by construction).
//!
//! ## Layering note (intentional inversion)
//!
//! This lives in `orchestrator/` (beside the `BoardEventBus` it emits through and
//! the `CliTokenRegistry` the scheduler mints into) but dispatches DOWN-and-OVER
//! into `crate::commands::{board,review,validate}` `_inner`s. That is deliberate:
//! the IPC server IS the CLI's command surface — a peer of the Tauri command
//! layer, not core orchestrator logic — so it reuses those handlers rather than
//! duplicating them.
//!
//! ## Transport (§R4)
//!
//! `tokio::net::UnixListener` — ZERO new dependency (`tokio` `full` already ships
//! it). The whole listener is `#[cfg(unix)]`; Windows (no stable AF_UNIX in older
//! builds) is deferred. Lifecycle: best-effort `remove_file` BEFORE bind
//! (stale-on-crash → else EADDRINUSE), `set_permissions(0o600)` right after (local
//! owner-only, no network), and ONE spawned task per connection (a `validate`
//! holds its connection for tens of seconds and must not block a concurrent
//! `comment`). The socket file is removed on app quit via a `RunEvent::Exit`
//! handler in `lib.rs`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// One CLI → app request. `{ token, verb, args }`, line-delimited JSON. The
/// `token` is the SOLE ticket identity (§R5): it resolves — via the
/// `CliTokenRegistry` — to the one subtask the request may act on, so there is no
/// separate `ticket` field to spoof. `args` is verb-specific and defaults to
/// null/empty when a verb takes none.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliRequest {
    pub token: String,
    pub verb: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// One app → CLI response. Exactly one of `result`/`error` is set. Mirrors the
/// §C.3 wire: `{ ok: true, result }` or `{ ok: false, error }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CliResponse {
    fn ok(result: serde_json::Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(message.into()),
        }
    }
}

/// The canonical socket path: `~/.phasr/phasr.sock`. Falls back to `/tmp` when
/// `$HOME` is unset (CI sandboxes), mirroring `scheduler::default_contract_root`.
/// Not gated: the path is meaningful on any OS even though `bind`/`serve` are unix.
pub fn socket_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".phasr")
        .join("phasr.sock")
}

#[cfg(unix)]
pub use unix_impl::{bind, serve, CliServer};

#[cfg(unix)]
mod unix_impl {
    use std::path::Path;
    use std::sync::Arc;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};

    use crate::domain::{Agent, WorkspaceStatus};
    use crate::orchestrator::cli_tokens::CliTokenRegistry;
    use crate::orchestrator::{BoardEventBus, SchedulerConfig, ValidateConfig};
    use crate::store::{BoardRepo, RepositoryRepo, RunCommandRepo, WorkspaceRepo};
    use crate::tickets::{LastEditedBy, TicketWriteRegistry};

    use super::{CliRequest, CliResponse};

    /// Everything one CLI request needs to dispatch through the command `_inner`s.
    /// Every field is cheaply cloneable (repos are `Clone`, the rest `Arc`), so a
    /// clone is handed to each per-connection task. The `tokens` registry is the
    /// SAME `Arc` the scheduler mints into (`with_cli`), so mint (there) and
    /// resolve (here) share one map.
    #[derive(Clone)]
    pub struct CliServer {
        pub workspaces: WorkspaceRepo,
        pub board: BoardRepo,
        pub repositories: RepositoryRepo,
        pub run_commands: RunCommandRepo,
        pub write_registry: Arc<TicketWriteRegistry>,
        pub board_events: Arc<BoardEventBus>,
        pub tokens: Arc<CliTokenRegistry>,
        pub scheduler_config: SchedulerConfig,
        pub validate_config: ValidateConfig,
    }

    /// Bind the CLI socket at `path` with the §R4 lifecycle: create the parent
    /// dir, best-effort `remove_file` BEFORE bind (a stale socket from a crash
    /// would otherwise fail bind with EADDRINUSE), then chmod 0600 so no other
    /// local user can connect. Returns the listener for `serve`.
    pub fn bind(path: &Path) -> std::io::Result<UnixListener> {
        use std::os::unix::fs::PermissionsExt;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Stale-on-crash cleanup MUST precede bind (§R4).
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        // Owner-only, local-only — no network, no other-user access (§R4/D6).
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(listener)
    }

    /// Accept loop: ONE spawned task per connection (§R4), so a slow `validate`
    /// can't head-of-line-block a `comment` on another connection. Runs until the
    /// listener errors (e.g. the socket file is removed on quit).
    pub async fn serve(listener: UnixListener, server: Arc<CliServer>) {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let server = server.clone();
                    tokio::spawn(async move {
                        handle_conn(stream, server).await;
                    });
                }
                Err(err) => {
                    eprintln!("phasr cli ipc: accept failed: {err}");
                    break;
                }
            }
        }
    }

    /// One connection = one request/response. Reads a single JSON line,
    /// dispatches, writes one JSON line back. A malformed line is a structured
    /// `{ ok:false }`, never a panic.
    async fn handle_conn(stream: UnixStream, server: Arc<CliServer>) {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        if let Err(err) = reader.read_line(&mut line).await {
            eprintln!("phasr cli ipc: read failed: {err}");
            return;
        }

        let response = match serde_json::from_str::<CliRequest>(line.trim()) {
            Ok(request) => dispatch(&server, &request).await,
            Err(err) => CliResponse::err(format!("malformed request: {err}")),
        };

        let mut bytes = serde_json::to_vec(&response)
            .unwrap_or_else(|_| br#"{"ok":false,"error":"failed to encode response"}"#.to_vec());
        bytes.push(b'\n');
        let _ = write_half.write_all(&bytes).await;
        let _ = write_half.flush().await;
    }

    /// Authenticate + route one request. Auth (§R5): the token must resolve, and
    /// the subtask it maps to must be actively `Running` — an agent can only
    /// mutate its own, live ticket. Every successful verb emits
    /// `phasr://board-changed` (keyed on the epic) so the open board moves live.
    async fn dispatch(server: &CliServer, request: &CliRequest) -> CliResponse {
        match dispatch_inner(server, request).await {
            Ok(result) => CliResponse::ok(result),
            Err(message) => CliResponse::err(message),
        }
    }

    async fn dispatch_inner(
        server: &CliServer,
        request: &CliRequest,
    ) -> Result<serde_json::Value, String> {
        // 1. Authenticate the token → the one subtask it may act on (§R5). An
        //    unknown/expired token authorizes nothing.
        let grant = server
            .tokens
            .resolve(&request.token)
            .ok_or_else(|| "not authorized: unknown or expired token".to_string())?;

        // 2. Owner-scoped read (the access boundary) + must be actively Running.
        let subtask = server
            .workspaces
            .get_for_user(&grant.subtask_id, &grant.user_id)
            .await
            .map_err(|_| "ticket not found for this token".to_string())?;
        if subtask.status != WorkspaceStatus::Running {
            return Err(format!(
                "ticket is not active (status: {}) — the agent must be running to advance the board",
                subtask.status.as_str()
            ));
        }

        // 3. Route. Each verb reuses the SAME `_inner` the Tauri command uses, then
        //    announces the epic so the board re-fetches live.
        let result = match request.verb.as_str() {
            "request-review" => {
                crate::commands::review::request_review_inner(
                    &subtask,
                    &grant.user_id,
                    // Attribution (G1): a CLI-fired request-review is the producing
                    // agent acting on its own ticket — never the human "you".
                    "agent",
                    &server.workspaces,
                    &server.board,
                    &server.repositories,
                    &server.write_registry,
                    &server.scheduler_config,
                )
                .await
                .map_err(|e| e.to_string())?;
                serde_json::json!({
                    "verb": "request-review",
                    "subtaskId": grant.subtask_id,
                    "state": "requested",
                })
            }
            "update-status" => {
                // Only `--done` is defined today → publish the handoff contract so
                // dependents unblock (the `publish_contract` action, A5).
                crate::commands::board::publish_contract_inner(
                    &grant.subtask_id,
                    &grant.user_id,
                    &server.workspaces,
                    &server.board,
                    &server.scheduler_config,
                )
                .await
                .map_err(|e| e.to_string())?;
                serde_json::json!({
                    "verb": "update-status",
                    "subtaskId": grant.subtask_id,
                    "published": true,
                })
            }
            "comment" => {
                let body = request
                    .args
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if body.is_empty() {
                    return Err("comment needs a non-empty body".to_string());
                }
                let repo_root = owned_repo_root(&server.repositories, &subtask.repository_id).await?;
                // Author by role so the thread names the agent (e.g. "backend").
                let author = subtask.role.as_deref().unwrap_or("agent");
                // A CLI comment is written BY the producing agent on its own ticket —
                // stamped `Agent`, never the human `"you"` (honesty #29).
                let comment = crate::tickets::add_comment(
                    &repo_root,
                    &grant.subtask_id,
                    author,
                    LastEditedBy::Agent,
                    body,
                )
                .map_err(|e| e.to_string())?;
                serde_json::to_value(comment).map_err(|e| e.to_string())?
            }
            "validate" => {
                let result = crate::commands::validate::run_and_persist_validate(
                    &subtask,
                    &grant.user_id,
                    &server.repositories,
                    &server.run_commands,
                    &server.write_registry,
                    &server.validate_config,
                )
                .await
                .map_err(|e| e.to_string())?;
                serde_json::to_value(result).map_err(|e| e.to_string())?
            }
            "new-ticket" => {
                let role = request.args.get("role").and_then(|v| v.as_str()).unwrap_or("");
                let prompt = request.args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                let after = request.args.get("after").and_then(|v| v.as_str());
                // `agent` is a lowercase enum on the wire; default to Claude if
                // absent/unknown (Agent::default), never an error.
                let agent = request
                    .args
                    .get("agent")
                    .and_then(|v| serde_json::from_value::<Agent>(v.clone()).ok())
                    .unwrap_or_else(Agent::default);
                // Bounded to the token's OWN epic (§R5) — never a request-supplied parent.
                let new_id = crate::commands::board::add_subtask_inner(
                    &grant.parent_id,
                    &grant.user_id,
                    role,
                    agent,
                    prompt,
                    after,
                    &server.workspaces,
                    &server.board,
                    &server.repositories,
                )
                .await
                .map_err(|e| e.to_string())?;
                serde_json::json!({ "verb": "new-ticket", "id": new_id })
            }
            other => return Err(format!("unknown verb `{other}`")),
        };

        // Move the open board live (architect §R1) — keyed on the epic, so even a
        // brand-new sibling (`new-ticket`) surfaces without a manual refresh.
        server.board_events.notify(&grant.parent_id);
        Ok(result)
    }

    /// The repo's local checkout, where ticket gate/comment files live. A repo
    /// with no checkout on this machine can't hold them.
    async fn owned_repo_root(
        repositories: &RepositoryRepo,
        repository_id: &str,
    ) -> Result<std::path::PathBuf, String> {
        let repository = repositories
            .get(repository_id)
            .await
            .map_err(|e| e.to_string())?;
        repository
            .local_path
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "repository has no local checkout on this machine".to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::commands::board::{
            create_decomposition_inner, DecompositionInput, EdgeInput, SubtaskInput,
        };
        use crate::domain::Repository;
        use crate::store::{init_pool, Db, WorkspaceUpdate};

        async fn seed_user(pool: &Db, uid: &str) {
            sqlx::query(
                "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
                 VALUES (?, ?, 'n', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
            )
            .bind(uid)
            .bind(uid)
            .bind(format!("{uid}@example.com"))
            .execute(pool)
            .await
            .unwrap();
        }

        /// Stand up a real board (parent + backend→frontend) under a repo with an
        /// on-disk checkout, flip `frontend` to Running, and build a `CliServer`
        /// wired to a shared token registry + board-event bus. Returns the server,
        /// the running subtask id, its epic id, and the kept-alive TempDir.
        async fn running_board() -> (Arc<CliServer>, String, String, tempfile::TempDir) {
            let dir = tempfile::tempdir().unwrap();
            let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
            let workspaces = WorkspaceRepo::new(pool.clone());
            let board = BoardRepo::new(pool.clone());
            let repositories = RepositoryRepo::new(pool.clone());
            let run_commands = RunCommandRepo::new(pool.clone());
            seed_user(&pool, "user-a").await;

            let checkout = dir.path().join("checkout");
            std::fs::create_dir_all(&checkout).unwrap();
            let repo = Repository::new(
                "repo".into(),
                Some(checkout.to_string_lossy().into_owned()),
                None,
            );
            repositories.insert_for_user(&repo, "user-a").await.unwrap();

            let input = DecompositionInput {
                repository_id: repo.id.clone(),
                parent_prompt: "build it".into(),
                subtasks: vec![
                    SubtaskInput { role: "backend".into(), agent: Agent::Claude, prompt: "be".into() },
                    SubtaskInput { role: "frontend".into(), agent: Agent::Claude, prompt: "fe".into() },
                ],
                edges: vec![EdgeInput { from_role: "backend".into(), to_role: "frontend".into() }],
            };
            let assembled =
                create_decomposition_inner(&input, "user-a", &workspaces, &board, &repositories)
                    .await
                    .unwrap();
            let frontend = assembled
                .subtasks
                .iter()
                .find(|s| s.role.as_deref() == Some("frontend"))
                .unwrap()
                .clone();
            // Flip it Running so the dispatch's "must be active" check passes.
            workspaces
                .update(
                    &frontend.id,
                    WorkspaceUpdate {
                        status: Some(WorkspaceStatus::Running),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();

            let mut scheduler_config = SchedulerConfig::default();
            scheduler_config.contract_root = dir.path().join("contracts");

            let server = Arc::new(CliServer {
                workspaces,
                board,
                repositories,
                run_commands,
                write_registry: Arc::new(TicketWriteRegistry::default()),
                board_events: Arc::new(BoardEventBus::new()),
                tokens: Arc::new(CliTokenRegistry::new()),
                scheduler_config,
                validate_config: ValidateConfig::default(),
            });
            (server, frontend.id, assembled.parent.id, dir)
        }

        /// Send one line-delimited request over the socket and read the response —
        /// the full round-trip the real `phasr` CLI performs.
        async fn round_trip(sock: &Path, request: serde_json::Value) -> CliResponse {
            let mut client = UnixStream::connect(sock).await.expect("connect to the cli socket");
            let mut line = serde_json::to_string(&request).unwrap();
            line.push('\n');
            client.write_all(line.as_bytes()).await.unwrap();
            client.flush().await.unwrap();
            let mut reader = BufReader::new(client);
            let mut resp = String::new();
            reader.read_line(&mut resp).await.unwrap();
            serde_json::from_str(resp.trim()).expect("a well-formed response line")
        }

        // CLI1 core: a `request-review` sent over a REAL Unix socket dispatches
        // through `request_review_inner` (review.json is written) AND emits
        // `board-changed` (the open board moves live).
        #[tokio::test]
        async fn dispatch_request_review_emits_board_changed_and_writes_review() {
            let (server, subtask_id, parent_id, dir) = running_board().await;
            let token = server.tokens.mint(&subtask_id, "user-a", &parent_id);
            let mut board_rx = server.board_events.subscribe();

            let sock = dir.path().join("phasr.sock");
            let listener = bind(&sock).unwrap();
            tokio::spawn(serve(listener, server.clone()));

            let response = round_trip(
                &sock,
                serde_json::json!({ "token": token, "verb": "request-review", "args": {} }),
            )
            .await;
            assert!(response.ok, "request-review should succeed: {:?}", response.error);

            // review.json landed via the reused `_inner`.
            let checkout = dir.path().join("checkout");
            let review = crate::tickets::read_gate_file(
                &checkout,
                &subtask_id,
                crate::tickets::GateFile::Review,
            )
            .unwrap();
            assert!(review.is_some(), "request-review must write review.json");

            // board-changed fired for the epic (the live-refresh seam).
            let event = tokio::time::timeout(std::time::Duration::from_secs(2), board_rx.recv())
                .await
                .expect("a board-changed event within 2s")
                .expect("the event channel is open");
            assert_eq!(event.parent_id, parent_id);
        }

        // §R5 auth: an unknown token, and a token whose subtask is NOT Running, are
        // both rejected with `ok:false` — an agent can only mutate its own, live
        // ticket, and nothing dispatches through an `_inner` for a bad request.
        #[tokio::test]
        async fn dispatch_rejects_unknown_token_and_inactive_ticket() {
            let (server, subtask_id, parent_id, dir) = running_board().await;
            let sock = dir.path().join("phasr.sock");
            let listener = bind(&sock).unwrap();
            tokio::spawn(serve(listener, server.clone()));

            // Unknown token → not authorized.
            let bad = round_trip(
                &sock,
                serde_json::json!({ "token": "nope", "verb": "request-review", "args": {} }),
            )
            .await;
            assert!(!bad.ok);
            assert!(bad.error.unwrap().contains("not authorized"));

            // A token minted for a subtask we then move OUT of Running is rejected.
            let token = server.tokens.mint(&subtask_id, "user-a", &parent_id);
            server
                .workspaces
                .update(
                    &subtask_id,
                    WorkspaceUpdate {
                        status: Some(WorkspaceStatus::Stopped),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            let inactive = round_trip(
                &sock,
                serde_json::json!({ "token": token, "verb": "request-review", "args": {} }),
            )
            .await;
            assert!(!inactive.ok);
            assert!(inactive.error.unwrap().contains("not active"));
        }

        // `new-ticket` over the socket grows the token's OWN epic and returns the
        // new id — the agent-writes-a-sibling path, bounded to `grant.parent_id`.
        #[tokio::test]
        async fn dispatch_new_ticket_grows_the_epic() {
            let (server, subtask_id, parent_id, dir) = running_board().await;
            let token = server.tokens.mint(&subtask_id, "user-a", &parent_id);
            let sock = dir.path().join("phasr.sock");
            let listener = bind(&sock).unwrap();
            tokio::spawn(serve(listener, server.clone()));

            let response = round_trip(
                &sock,
                serde_json::json!({
                    "token": token,
                    "verb": "new-ticket",
                    "args": { "role": "docs", "agent": "claude", "prompt": "write docs" },
                }),
            )
            .await;
            assert!(response.ok, "new-ticket should succeed: {:?}", response.error);
            let new_id = response.result.unwrap()["id"].as_str().unwrap().to_string();

            let added = server.workspaces.get_for_user(&new_id, "user-a").await.unwrap();
            assert_eq!(added.parent_id.as_deref(), Some(parent_id.as_str()));
            assert_eq!(added.role.as_deref(), Some("docs"));
        }

        // honesty #29: a `comment` issued over the CLI is written BY the producing
        // agent, so it is stamped `authorKind: "agent"` — NOT the human `"you"`.
        // Asserted on BOTH the wire response and the persisted `comments.jsonl`.
        #[tokio::test]
        async fn dispatch_comment_is_authored_agent_not_you() {
            let (server, subtask_id, parent_id, dir) = running_board().await;
            let token = server.tokens.mint(&subtask_id, "user-a", &parent_id);
            let sock = dir.path().join("phasr.sock");
            let listener = bind(&sock).unwrap();
            tokio::spawn(serve(listener, server.clone()));

            let response = round_trip(
                &sock,
                serde_json::json!({
                    "token": token,
                    "verb": "comment",
                    "args": { "body": "shipped the backend" },
                }),
            )
            .await;
            assert!(response.ok, "comment should succeed: {:?}", response.error);

            // The wire response is the created comment — honestly `"agent"`.
            let result = response.result.unwrap();
            assert_eq!(result["authorKind"], "agent", "a CLI comment must not be stamped \"you\"");
            assert_eq!(result["body"], "shipped the backend");

            // And it persisted with the same honest kind (author = the ticket role).
            let checkout = dir.path().join("checkout");
            let comments = crate::tickets::list_comments(&checkout, &subtask_id).unwrap();
            assert_eq!(comments.len(), 1);
            assert!(
                matches!(comments[0].author_kind, LastEditedBy::Agent),
                "the persisted comment must be authored \"agent\", never \"you\""
            );
            assert_eq!(comments[0].author, "frontend");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The CLI wire round-trips: a serialized request/response deserializes back to
    // the same fields. This is the ONLY contract the (dependency-light) CLI binary
    // and the app must agree on — they duplicate these structs, so the shapes must
    // stay byte-compatible.
    #[test]
    fn cli_request_round_trips() {
        let request = CliRequest {
            token: "tok-123".into(),
            verb: "comment".into(),
            args: serde_json::json!({ "body": "hello" }),
        };
        let line = serde_json::to_string(&request).unwrap();
        let back: CliRequest = serde_json::from_str(&line).unwrap();
        assert_eq!(back.token, "tok-123");
        assert_eq!(back.verb, "comment");
        assert_eq!(back.args["body"], "hello");
    }

    // A verb with no args deserializes with `args` defaulted (the CLI omits it).
    #[test]
    fn cli_request_defaults_missing_args() {
        let back: CliRequest =
            serde_json::from_str(r#"{"token":"t","verb":"request-review"}"#).unwrap();
        assert_eq!(back.verb, "request-review");
        assert!(back.args.is_null());
    }

    // The response round-trips, and the success/error shapes are mutually exclusive
    // on the wire (only the populated arm serializes).
    #[test]
    fn cli_response_round_trips_ok_and_err() {
        let ok = CliResponse::ok(serde_json::json!({ "id": "x" }));
        let ok_line = serde_json::to_string(&ok).unwrap();
        assert!(ok_line.contains("\"ok\":true"));
        assert!(!ok_line.contains("error"));
        let ok_back: CliResponse = serde_json::from_str(&ok_line).unwrap();
        assert!(ok_back.ok);
        assert_eq!(ok_back.result.unwrap()["id"], "x");

        let err = CliResponse::err("bad token");
        let err_line = serde_json::to_string(&err).unwrap();
        assert!(err_line.contains("\"ok\":false"));
        assert!(!err_line.contains("result"));
        let err_back: CliResponse = serde_json::from_str(&err_line).unwrap();
        assert!(!err_back.ok);
        assert_eq!(err_back.error.as_deref(), Some("bad token"));
    }
}
