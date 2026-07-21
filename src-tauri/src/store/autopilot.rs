use sqlx::Row;

use super::error::StoreError;
use super::pool::Db;

/// Persistence for the global autopilot kill switch (Phase 5a, §5) — a singleton
/// row in the local-only `autopilot_state` table (migration 0015). The switch is
/// a PERSISTED true-halt: it survives a crash/reboot and is re-read at driver
/// boot so a 2am panic-button stays pressed (there is NO auto-resume). Never
/// referenced by any sync filter, so it is machine-local by construction.
#[derive(Clone)]
pub struct AutopilotStateRepo {
    db: Db,
}

impl AutopilotStateRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Read the persisted halt flag. `false` (running) if the singleton row is
    /// somehow absent — a missing row must never wedge autopilot permanently.
    pub async fn kill_switch_halted(&self) -> Result<bool, StoreError> {
        let row = sqlx::query("SELECT kill_switch_halted FROM autopilot_state WHERE id = 1")
            .fetch_optional(&self.db)
            .await?;
        Ok(row
            .map(|r| r.try_get::<i64, _>("kill_switch_halted").unwrap_or(0) != 0)
            .unwrap_or(false))
    }

    /// Persist the halt flag. An `UPSERT` so the write is robust even if the
    /// seeded row were missing.
    pub async fn set_kill_switch(&self, halted: bool) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO autopilot_state (id, kill_switch_halted) VALUES (1, ?)
             ON CONFLICT(id) DO UPDATE SET kill_switch_halted = excluded.kill_switch_halted",
        )
        .bind(halted as i64)
        .execute(&self.db)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;

    async fn fresh() -> AutopilotStateRepo {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        std::mem::forget(dir);
        AutopilotStateRepo::new(pool)
    }

    // The kill switch defaults to NOT halted, persists a set, and reads it back —
    // this is exactly the boot re-read path (§5, restart-safe, no auto-resume).
    #[tokio::test]
    async fn kill_switch_persists_and_survives_a_reopen() {
        let repo = fresh().await;
        assert!(!repo.kill_switch_halted().await.unwrap(), "defaults to running");

        repo.set_kill_switch(true).await.unwrap();
        assert!(
            repo.kill_switch_halted().await.unwrap(),
            "a set halt must be readable back (survives restart via the DB)"
        );

        repo.set_kill_switch(false).await.unwrap();
        assert!(!repo.kill_switch_halted().await.unwrap());
    }
}
