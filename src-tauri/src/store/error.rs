use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("not found")]
    NotFound,

    #[error("invalid value for field `{field}`: {message}")]
    InvalidValue {
        field: &'static str,
        message: String,
    },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for StoreError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
