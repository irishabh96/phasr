//! The `phasr` CLI token registry (Story CLI1, architect §R5).
//!
//! A spawned ticket agent advances its OWN ticket on the board by shelling out to
//! `phasr <verb>` (see `orchestrator::ipc_server` + `bin/phasr_cli.rs`). Every
//! request carries a `PHASR_TOKEN`; this registry is the in-memory map that
//! resolves a token to the ONE subtask it may mutate.
//!
//! ## The token is accident-prevention, NOT a hard security boundary (§R5)
//!
//! The agent already runs arbitrary code AS the user — it can scribble ticket
//! files on disk directly; the socket adds no filesystem reach. So the token's
//! job is blast-radius bounding: it scopes a request to the agent's own ticket
//! (and, for `new-ticket`, to that ticket's epic), so a confused agent can't move
//! a SIBLING's card by accident. That's why there are no per-connection
//! handshakes / rotating tokens here — a per-subtask token + a 0600 socket is the
//! right weight for local single-user.
//!
//! ## Lifecycle (§R5)
//!
//! - Minted per-subtask at spawn (`spawn_ready_subtask`), keyed `token →
//!   (subtaskId, userId, parentId)`.
//! - Re-minted on respawn: `mint` drops any prior token for the same subtask, so
//!   only the newest is ever live.
//! - Invalidated on subtask exit/delete (`invalidate_subtask`).
//! - **NEVER persisted.** The registry is pure in-memory state — a restart starts
//!   empty and re-mints on the next spawn, so a harvested token dies with the
//!   process (residual risk: a same-user `ps eww` can read a sibling's env → a
//!   sibling token is harvestable; blast radius = mutate a sibling in the same
//!   epic, strictly LESS than the fs access the agent already has).

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::Mutex;
use uuid::Uuid;

/// What a minted token grants: the ONE subtask (ticket) it may act on, that
/// subtask's owner (for owner-scoped reads), and the epic (`parent_id`) any
/// `new-ticket` it creates is bounded to (§R5 — "never an arbitrary
/// repo/parent"). Cloned out on `resolve` so the registry lock is never held
/// across the dispatch's `.await`s.
#[derive(Debug, Clone)]
pub struct CliGrant {
    pub subtask_id: String,
    pub user_id: String,
    pub parent_id: String,
}

/// The two runtime paths the scheduler injects into a spawned subtask's env so
/// its agent can reach the running app over the socket (§J3/§J4): the absolute
/// `phasr` CLI binary (`PHASR_BIN`) and the app's Unix socket (`PHASR_SOCK`).
/// Built once at boot and handed to the orchestrator via `with_cli`; `None` on
/// the orchestrator under `cargo test`, so scheduled spawns inject nothing and
/// stay byte-identical to pre-CLI behavior.
#[derive(Debug, Clone)]
pub struct CliSpawnConfig {
    pub bin_path: PathBuf,
    pub socket_path: PathBuf,
}

/// In-memory registry of per-subtask CLI tokens (§R5). `parking_lot::Mutex`
/// because every access is a short map op — never held across an `.await`.
#[derive(Default)]
pub struct CliTokenRegistry {
    tokens: Mutex<HashMap<String, CliGrant>>,
}

impl CliTokenRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh opaque token for `subtask_id`, replacing any prior token for
    /// the SAME subtask (a respawn re-mints → the old one stops resolving).
    /// Returns the token to inject as `PHASR_TOKEN`.
    pub fn mint(&self, subtask_id: &str, user_id: &str, parent_id: &str) -> String {
        let token = Uuid::new_v4().to_string();
        let mut guard = self.tokens.lock();
        // Only the newest token for a subtask is ever live (re-mint on respawn).
        guard.retain(|_, grant| grant.subtask_id != subtask_id);
        guard.insert(
            token.clone(),
            CliGrant {
                subtask_id: subtask_id.to_string(),
                user_id: user_id.to_string(),
                parent_id: parent_id.to_string(),
            },
        );
        token
    }

    /// Resolve a token to its grant (cloned), or `None` if unknown/expired. The
    /// SOLE authentication step: a token that doesn't resolve is rejected by the
    /// IPC server, so an agent can only ever reach the subtask its token maps to.
    pub fn resolve(&self, token: &str) -> Option<CliGrant> {
        self.tokens.lock().get(token).cloned()
    }

    /// Invalidate every token for `subtask_id` — called when the subtask exits or
    /// is deleted, so a dead agent's token can't be replayed.
    pub fn invalidate_subtask(&self, subtask_id: &str) {
        self.tokens
            .lock()
            .retain(|_, grant| grant.subtask_id != subtask_id);
    }

    /// Number of live tokens. Test-only — the map is otherwise opaque.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.tokens.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mint → resolve round-trips the full grant (subtask + owner + epic).
    #[test]
    fn mint_then_resolve_round_trips_the_grant() {
        let registry = CliTokenRegistry::new();
        let token = registry.mint("subtask-1", "user-a", "epic-1");

        let grant = registry.resolve(&token).expect("a minted token resolves");
        assert_eq!(grant.subtask_id, "subtask-1");
        assert_eq!(grant.user_id, "user-a");
        assert_eq!(grant.parent_id, "epic-1");
    }

    // reject-mismatch: an unknown/garbage token resolves to None → the server
    // rejects it. There is no way to target another subtask because the server
    // derives the subtask from the token, not from the request.
    #[test]
    fn unknown_token_does_not_resolve() {
        let registry = CliTokenRegistry::new();
        registry.mint("subtask-1", "user-a", "epic-1");
        assert!(
            registry.resolve("not-a-real-token").is_none(),
            "a token that was never minted must not authorize anything"
        );
    }

    // new-ticket-epic-bound: the grant carries the epic (`parent_id`) the token
    // was minted for, which is EXACTLY what bounds `new-ticket` to the agent's own
    // epic (§R5) — the server passes `grant.parent_id`, never a request-supplied one.
    #[test]
    fn grant_carries_the_epic_new_ticket_is_bound_to() {
        let registry = CliTokenRegistry::new();
        let token = registry.mint("subtask-1", "user-a", "epic-42");
        let grant = registry.resolve(&token).unwrap();
        assert_eq!(
            grant.parent_id, "epic-42",
            "new-ticket is bounded to the token's own epic, taken from the grant"
        );
    }

    // re-mint: minting again for the same subtask (a respawn) invalidates the old
    // token and yields a distinct new one — only the newest is live.
    #[test]
    fn re_mint_invalidates_the_previous_token() {
        let registry = CliTokenRegistry::new();
        let old = registry.mint("subtask-1", "user-a", "epic-1");
        let new = registry.mint("subtask-1", "user-a", "epic-1");

        assert_ne!(old, new, "a re-mint produces a fresh token");
        assert!(
            registry.resolve(&old).is_none(),
            "the previous token stops resolving after a re-mint"
        );
        assert!(registry.resolve(&new).is_some(), "the new token resolves");
        assert_eq!(registry.len(), 1, "a subtask never accumulates stale tokens");
    }

    // Invalidation on exit/delete drops the token so a dead agent can't replay it.
    #[test]
    fn invalidate_subtask_drops_its_token() {
        let registry = CliTokenRegistry::new();
        let token = registry.mint("subtask-1", "user-a", "epic-1");
        registry.invalidate_subtask("subtask-1");
        assert!(
            registry.resolve(&token).is_none(),
            "an invalidated subtask's token must no longer authorize"
        );
    }

    // Two live subtasks each keep their own token; invalidating one leaves the
    // other intact (blast-radius bounding, not a global reset).
    #[test]
    fn tokens_are_isolated_per_subtask() {
        let registry = CliTokenRegistry::new();
        let a = registry.mint("subtask-a", "user-a", "epic-1");
        let b = registry.mint("subtask-b", "user-a", "epic-1");
        registry.invalidate_subtask("subtask-a");
        assert!(registry.resolve(&a).is_none());
        assert!(
            registry.resolve(&b).is_some(),
            "invalidating one subtask must not touch a sibling's token"
        );
    }
}
