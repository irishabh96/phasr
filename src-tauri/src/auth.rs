//! Auth session state for the Rust side of Phasr.
//!
//! Holds the current Clerk JWT (provided by the React app after sign-in) so
//! protected Tauri commands can reject calls made before a user has signed in.
//!
//! Signature verification against Clerk's JWKS is a planned follow-up — see
//! the rebuild plan's Auth Gate Design section. The current implementation
//! parses the JWT payload to extract `sub` (user id) but does not verify the
//! signature. The frontend `<ClerkProvider>` is the primary gate; this layer
//! exists to stop someone from poking at Tauri commands via dev tools without
//! a session.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use parking_lot::RwLock;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    // Reserved for the planned auth gate (see module docstring).
    #[allow(dead_code)]
    #[error("not signed in")]
    NotSignedIn,
    #[error("malformed jwt: {0}")]
    MalformedJwt(String),
}

impl serde::Serialize for AuthError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
struct JwtClaims {
    sub: String,
    #[allow(dead_code)] // parsed for completeness; auth gate will check it
    #[serde(default)]
    exp: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub user_id: String,
    #[allow(dead_code)] // held for the planned backend-call path
    pub jwt: String,
}

#[derive(Default)]
pub struct SessionState {
    inner: RwLock<Option<Session>>,
}

impl SessionState {
    pub fn current(&self) -> Option<Session> {
        self.inner.read().clone()
    }

    pub fn set(&self, session: Session) {
        *self.inner.write() = Some(session);
    }

    pub fn clear(&self) {
        *self.inner.write() = None;
    }

    /// Returns the current session or an error suitable for surfacing to the
    /// frontend. Use this from protected Tauri commands.
    #[allow(dead_code)] // wired up by the planned auth gate
    pub fn require(&self) -> Result<Session, AuthError> {
        self.current().ok_or(AuthError::NotSignedIn)
    }
}

fn parse_jwt_payload(jwt: &str) -> Result<JwtClaims, AuthError> {
    let mut parts = jwt.split('.');
    let _header = parts
        .next()
        .ok_or_else(|| AuthError::MalformedJwt("missing header".into()))?;
    let payload_b64 = parts
        .next()
        .ok_or_else(|| AuthError::MalformedJwt("missing payload".into()))?;
    let _sig = parts
        .next()
        .ok_or_else(|| AuthError::MalformedJwt("missing signature".into()))?;
    if parts.next().is_some() {
        return Err(AuthError::MalformedJwt("too many segments".into()));
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| AuthError::MalformedJwt(format!("payload not base64url: {e}")))?;
    let claims: JwtClaims = serde_json::from_slice(&payload_bytes)
        .map_err(|e| AuthError::MalformedJwt(format!("payload not valid JSON: {e}")))?;
    Ok(claims)
}

#[tauri::command]
pub fn set_session(jwt: String, state: State<'_, Arc<SessionState>>) -> Result<String, AuthError> {
    let claims = parse_jwt_payload(&jwt)?;
    let user_id = claims.sub.clone();
    state.set(Session {
        user_id: claims.sub,
        jwt,
    });
    Ok(user_id)
}

#[tauri::command]
pub fn clear_session(state: State<'_, Arc<SessionState>>) {
    state.clear();
}

#[tauri::command]
pub fn current_user_id(state: State<'_, Arc<SessionState>>) -> Option<String> {
    state.current().map(|s| s.user_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal HS256-shaped fake JWT — we only parse the payload so a fake
    // header/signature is fine.
    fn fake_jwt(payload: &serde_json::Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(b"{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        let payload_str = serde_json::to_string(payload).unwrap();
        let body = URL_SAFE_NO_PAD.encode(payload_str.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(b"signature");
        format!("{header}.{body}.{signature}")
    }

    #[test]
    fn parses_valid_payload() {
        let jwt = fake_jwt(&serde_json::json!({ "sub": "user_abc", "exp": 999 }));
        let claims = parse_jwt_payload(&jwt).expect("should parse");
        assert_eq!(claims.sub, "user_abc");
        assert_eq!(claims.exp, Some(999));
    }

    #[test]
    fn rejects_missing_segments() {
        let err = parse_jwt_payload("only.two").unwrap_err();
        assert!(matches!(err, AuthError::MalformedJwt(_)));
    }

    #[test]
    fn rejects_extra_segments() {
        let err = parse_jwt_payload("a.b.c.d").unwrap_err();
        assert!(matches!(err, AuthError::MalformedJwt(_)));
    }

    #[test]
    fn rejects_non_json_payload() {
        let header = URL_SAFE_NO_PAD.encode(b"hdr");
        let bad_payload = URL_SAFE_NO_PAD.encode(b"not json");
        let sig = URL_SAFE_NO_PAD.encode(b"sig");
        let err = parse_jwt_payload(&format!("{header}.{bad_payload}.{sig}")).unwrap_err();
        assert!(matches!(err, AuthError::MalformedJwt(_)));
    }

    #[test]
    fn state_round_trip() {
        let state = SessionState::default();
        assert!(state.current().is_none());
        state.set(Session {
            user_id: "u1".into(),
            jwt: "tok".into(),
        });
        assert_eq!(state.current().unwrap().user_id, "u1");
        state.clear();
        assert!(state.current().is_none());
    }

    #[test]
    fn require_errors_when_signed_out() {
        let state = SessionState::default();
        assert!(matches!(state.require(), Err(AuthError::NotSignedIn)));
    }
}
