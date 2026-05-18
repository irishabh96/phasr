use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::domain::Preset;

use super::error::StoreError;
use super::pool::Db;

#[derive(Clone)]
pub struct PresetRepo {
    db: Db,
}

impl PresetRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn insert(&self, preset: &Preset) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO presets (
                id, name, command, icon, is_default, is_enabled, is_seed, sort_order,
                created_at, updated_at, synced_at, dirty
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)",
        )
        .bind(&preset.id)
        .bind(&preset.name)
        .bind(&preset.command)
        .bind(&preset.icon)
        .bind(preset.is_default as i64)
        .bind(preset.is_enabled as i64)
        .bind(preset.is_seed as i64)
        .bind(preset.sort_order)
        .bind(preset.created_at.to_rfc3339())
        .bind(preset.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<Preset>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, name, command, icon, is_default, is_enabled, is_seed, sort_order,
                    created_at, updated_at
             FROM presets
             ORDER BY sort_order ASC, name ASC",
        )
        .fetch_all(&self.db)
        .await?;
        rows.iter().map(row_to_preset).collect()
    }

    pub async fn count(&self) -> Result<i64, StoreError> {
        let row = sqlx::query("SELECT COUNT(*) AS cnt FROM presets")
            .fetch_one(&self.db)
            .await?;
        Ok(row.try_get("cnt")?)
    }

    /// Inserts the bundled seed presets if the table is empty. Idempotent.
    pub async fn seed_if_empty(&self) -> Result<usize, StoreError> {
        if self.count().await? > 0 {
            return Ok(0);
        }
        let seeded = Preset::seeded();
        for preset in &seeded {
            self.insert(preset).await?;
        }
        Ok(seeded.len())
    }

    /// For each seeded preset (matched by name + is_seed=true): if it
    /// exists with a different command, update it; if it's missing,
    /// insert it. User-added presets are left alone. Run this on every
    /// boot so old DBs pick up command tweaks when we ship them.
    pub async fn sync_seeded(&self) -> Result<(), StoreError> {
        let existing = self.list().await?;
        let now = Utc::now().to_rfc3339();
        for canonical in Preset::seeded() {
            let match_ = existing
                .iter()
                .find(|p| p.is_seed && p.name == canonical.name);
            match match_ {
                Some(existing_row) if existing_row.command != canonical.command => {
                    sqlx::query(
                        "UPDATE presets SET command = ?, updated_at = ?, dirty = 1 WHERE id = ?",
                    )
                    .bind(&canonical.command)
                    .bind(&now)
                    .bind(&existing_row.id)
                    .execute(&self.db)
                    .await?;
                }
                Some(_) => {}
                None => {
                    self.insert(&canonical).await?;
                }
            }
        }
        Ok(())
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), StoreError> {
        let res = sqlx::query(
            "UPDATE presets SET is_enabled = ?, updated_at = ?, dirty = 1 WHERE id = ?",
        )
        .bind(enabled as i64)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.db)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

fn row_to_preset(row: &sqlx::sqlite::SqliteRow) -> Result<Preset, StoreError> {
    Ok(Preset {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        command: row.try_get("command")?,
        icon: row.try_get("icon")?,
        is_default: row.try_get::<i64, _>("is_default")? != 0,
        is_enabled: row.try_get::<i64, _>("is_enabled")? != 0,
        is_seed: row.try_get::<i64, _>("is_seed")? != 0,
        sort_order: row.try_get("sort_order")?,
        created_at: parse_timestamp(row.try_get::<String, _>("created_at")?, "created_at")?,
        updated_at: parse_timestamp(row.try_get::<String, _>("updated_at")?, "updated_at")?,
    })
}

fn parse_timestamp(value: String, field: &'static str) -> Result<DateTime<Utc>, StoreError> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|err| StoreError::InvalidValue {
            field,
            message: err.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::init_pool;
    use std::path::PathBuf;

    async fn fresh() -> PresetRepo {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        PresetRepo::new(pool)
    }

    #[tokio::test]
    async fn seeds_seven_default_agents() {
        let repo = fresh().await;
        let inserted = repo.seed_if_empty().await.unwrap();
        assert_eq!(inserted, 7);
        let list = repo.list().await.unwrap();
        assert_eq!(list.len(), 7);
        assert_eq!(list[0].name, "Claude");
        assert!(list.iter().all(|p| p.is_seed));
    }

    #[tokio::test]
    async fn seeding_twice_is_a_noop() {
        let repo = fresh().await;
        repo.seed_if_empty().await.unwrap();
        let second = repo.seed_if_empty().await.unwrap();
        assert_eq!(second, 0);
        assert_eq!(repo.list().await.unwrap().len(), 7);
    }

    #[tokio::test]
    async fn set_enabled_toggles_flag() {
        let repo = fresh().await;
        repo.seed_if_empty().await.unwrap();
        let presets = repo.list().await.unwrap();
        let target = &presets[1];

        repo.set_enabled(&target.id, false).await.unwrap();
        let after = repo.list().await.unwrap();
        let updated = after.iter().find(|p| p.id == target.id).unwrap();
        assert!(!updated.is_enabled);
    }
}
