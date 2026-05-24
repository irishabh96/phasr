#[cfg(test)]
use chrono::{DateTime, Utc};

use crate::domain::User;

use super::error::StoreError;
use super::pool::Db;

#[derive(Clone)]
pub struct UserRepo {
    db: Db,
}

impl UserRepo {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn upsert_from_clerk_profile(&self, user: &User) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO users (
                id, clerk_user_id, name, email, image_url,
                created_at, updated_at, synced_at, dirty
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)
             ON CONFLICT(id) DO UPDATE SET
                clerk_user_id = excluded.clerk_user_id,
                name = excluded.name,
                email = excluded.email,
                image_url = excluded.image_url,
                updated_at = excluded.updated_at,
                dirty = 1",
        )
        .bind(&user.id)
        .bind(&user.clerk_user_id)
        .bind(&user.name)
        .bind(&user.email)
        .bind(&user.image_url)
        .bind(user.created_at.to_rfc3339())
        .bind(user.updated_at.to_rfc3339())
        .execute(&self.db)
        .await?;

        self.attach_unowned_local_rows(&user.id).await
    }

    pub async fn attach_unowned_local_rows(&self, user_id: &str) -> Result<(), StoreError> {
        for table in [
            "repositories",
            "workspaces",
            "repository_config",
            "run_commands",
            "user_settings",
        ] {
            let sql = format!("UPDATE {table} SET user_id = ? WHERE user_id IS NULL");
            sqlx::query(&sql).bind(user_id).execute(&self.db).await?;
        }

        Ok(())
    }

    #[cfg(test)]
    pub async fn get(&self, id: &str) -> Result<User, StoreError> {
        let row = sqlx::query(
            "SELECT id, clerk_user_id, name, email, image_url, created_at, updated_at
             FROM users
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        row.as_ref()
            .map(row_to_user)
            .transpose()?
            .ok_or(StoreError::NotFound)
    }
}

#[cfg(test)]
fn row_to_user(row: &sqlx::sqlite::SqliteRow) -> Result<User, StoreError> {
    use sqlx::Row;

    Ok(User {
        id: row.try_get("id")?,
        clerk_user_id: row.try_get("clerk_user_id")?,
        name: row.try_get("name")?,
        email: row.try_get("email")?,
        image_url: row.try_get("image_url")?,
        created_at: parse_timestamp(row.try_get::<String, _>("created_at")?, "created_at")?,
        updated_at: parse_timestamp(row.try_get::<String, _>("updated_at")?, "updated_at")?,
    })
}

#[cfg(test)]
fn parse_timestamp(value: String, field: &'static str) -> Result<DateTime<Utc>, StoreError> {
    use chrono::{DateTime, Utc};

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
    use crate::domain::Repository;
    use crate::store::{init_pool, RepositoryRepo};
    use sqlx::Row;
    use std::path::PathBuf;

    async fn fresh() -> (Db, UserRepo) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        (pool.clone(), UserRepo::new(pool))
    }

    #[tokio::test]
    async fn upsert_persists_profile_and_backfills_local_rows() {
        let (db, users) = fresh().await;
        let repositories = RepositoryRepo::new(db.clone());
        let repository = Repository::new("my-app".into(), None, None);
        repositories.insert(&repository).await.unwrap();

        let user = User::from_clerk_profile(
            "user_123".into(),
            Some("Rishabh".into()),
            Some("rishabh@example.com".into()),
            Some("https://example.com/avatar.png".into()),
        );
        users.upsert_from_clerk_profile(&user).await.unwrap();

        let stored = users.get("user_123").await.unwrap();
        assert_eq!(stored.name.as_deref(), Some("Rishabh"));
        assert_eq!(stored.email.as_deref(), Some("rishabh@example.com"));

        let row = sqlx::query("SELECT user_id FROM repositories WHERE id = ?")
            .bind(&repository.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(row.try_get::<String, _>("user_id").unwrap(), "user_123");
    }
}
