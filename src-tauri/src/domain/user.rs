use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub clerk_user_id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub image_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl User {
    pub fn from_clerk_profile(
        clerk_user_id: String,
        name: Option<String>,
        email: Option<String>,
        image_url: Option<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: clerk_user_id.clone(),
            clerk_user_id,
            name,
            email,
            image_url,
            created_at: now,
            updated_at: now,
        }
    }
}
