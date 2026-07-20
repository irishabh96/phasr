//! Role personas: the stack-aware system-prompt guidance seeded ahead of a
//! scheduled subtask's spawn prompt (Phase 4).
//!
//! Each persona is a short, role-first `.md` file under
//! `src-tauri/resources/personas/`, embedded into the binary at compile time via
//! `include_str!` (NOT runtime-loaded — no path resolution across dev/bundle, no
//! missing-file failure mode, no `tauri.conf.json` change). A subtask's freeform
//! kebab-case `role` is mapped to one of the eight canonical personas by
//! `persona_for_role`, a fuzzy token matcher; an unmapped role yields `None`, so
//! the spawn prompt stays byte-identical to a pre-Phase-4 spawn.
//!
//! Provenance (see `/NOTICE`): the persona set is a re-authored derivative of the
//! Safe Agentic Workflow (SAW) persona architecture — MIT, (c) J. Scott Graham
//! (@cheddarfox) / ByBren, LLC. The content shipped here is rewritten for phasr;
//! the SAW copyright + MIT permission notice are retained in `/NOTICE` as the
//! license requires, and each persona file carries an attribution header.

use crate::domain::Agent;

// ── the embedded persona set (compile-time `include_str!`) ───────────────────
// Paths are relative to THIS file (`src-tauri/src/orchestrator/personas.rs`):
// `../` -> `src/`, `../../` -> `src-tauri/`, then into `resources/personas/`.

pub const ARCHITECT: &str = include_str!("../../resources/personas/architect.md");
pub const SECURITY: &str = include_str!("../../resources/personas/security.md");
pub const QA: &str = include_str!("../../resources/personas/qa.md");
pub const DATA: &str = include_str!("../../resources/personas/data.md");
pub const DESIGN: &str = include_str!("../../resources/personas/design.md");
pub const DOCS: &str = include_str!("../../resources/personas/docs.md");
pub const FRONTEND: &str = include_str!("../../resources/personas/frontend.md");
pub const BACKEND: &str = include_str!("../../resources/personas/backend.md");

/// The canonical persona roles, in **matching precedence order** (also the order
/// the planner presents them, S4). Each entry is
/// `(role name, one-line description, suggested default agent)`. Single source of
/// truth shared by `persona_for_role` (the matcher) and `planner::build_prompt`
/// (the advisory role menu) so the prompt and the matcher can never drift.
///
/// The default-agent column is ADVISORY only — the planner still assigns freely,
/// there is no backend routing keyed off it.
pub const CANONICAL_ROLES: &[(&str, &str, Agent)] = &[
    (
        "architect",
        "system design, boundaries/layering, propose-before-build, cross-ticket contracts",
        Agent::Claude,
    ),
    (
        "security",
        "threat-model the change, secrets/permissions/input-validation, least privilege",
        Agent::Claude,
    ),
    (
        "qa",
        "validate against acceptance criteria; unit/integration/e2e; run the checks honestly",
        Agent::Codex,
    ),
    (
        "data",
        "schema and migrations, data integrity, reversible/forward-only changes",
        Agent::Claude,
    ),
    (
        "design",
        "UX/visual quality, design-token discipline, state + accessibility coverage",
        Agent::Claude,
    ),
    (
        "docs",
        "clear docs that ship with the code and never drift from it",
        Agent::Claude,
    ),
    (
        "frontend",
        "React/TS components, reuse-before-create, honest loading/error states",
        Agent::Claude,
    ),
    (
        "backend",
        "commands + layering (domain/store/git/pty/orchestrator), typed errors, handoff contracts",
        Agent::Claude,
    ),
];

/// The alias tokens that resolve to each canonical persona, in the SAME
/// precedence order as `CANONICAL_ROLES`. First canonical whose alias set matches
/// any token of the role wins (§C precedence: architect > security > qa > data >
/// design > docs > frontend > backend), so an ambiguous multi-token role like
/// `data-api` resolves deterministically to `data` even though `api` -> backend
/// also matches. `architect` additionally matches by the `arch*` prefix rule (see
/// `persona_for_role`).
const ALIASES: &[(&str, &[&str])] = &[
    ("architect", &["architect", "architecture", "arch"]),
    ("security", &["security", "sec", "authz", "auth"]),
    ("qa", &["qa", "qas", "test", "tests", "e2e"]),
    ("data", &["data", "db", "database", "migration", "schema", "sql"]),
    ("design", &["design", "ux", "visual"]),
    ("docs", &["docs", "doc", "writer", "documentation"]),
    ("frontend", &["frontend", "fe", "ui", "client", "web"]),
    ("backend", &["backend", "be", "api", "server", "tauri", "rust", "core"]),
];

/// The embedded persona content for a canonical key. Kept beside `ALIASES`/
/// `CANONICAL_ROLES` (which use string keys) so the three tables stay aligned.
fn content_for(canonical: &str) -> &'static str {
    match canonical {
        "architect" => ARCHITECT,
        "security" => SECURITY,
        "qa" => QA,
        "data" => DATA,
        "design" => DESIGN,
        "docs" => DOCS,
        "frontend" => FRONTEND,
        // `backend` and any drift caught by the exhaustive-alias test below.
        _ => BACKEND,
    }
}

/// Map a subtask's freeform kebab-case `role` to one of the eight canonical
/// personas, or `None` when nothing matches (unmatched -> no persona segment ->
/// byte-identical to a pre-Phase-4 spawn).
///
/// Matching is **token-based and case/whitespace-insensitive**: the role is
/// lowercased and split on every non-alphanumeric boundary, then each canonical is
/// tried in `ALIASES` precedence order and the FIRST whose alias set contains one
/// of the tokens wins. `architect` also matches any token with the `arch` prefix
/// (`architecture`, `arch`). Token-based (not raw substring) so `frontend-ui`
/// matches `frontend`/`ui` without `backend` matching on a stray `end`.
pub fn persona_for_role(role: &str) -> Option<&'static str> {
    let tokens: Vec<String> = role
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_lowercase())
        .collect();
    if tokens.is_empty() {
        return None;
    }

    for (canonical, aliases) in ALIASES {
        let hit = tokens.iter().any(|t| {
            // `architect` uses a prefix rule (`arch*`) so `architecture`/`arch`/
            // `architecting` all resolve; every other canonical matches on exact
            // token equality.
            if *canonical == "architect" {
                t.starts_with("arch")
            } else {
                aliases.contains(&t.as_str())
            }
        });
        if hit {
            return Some(content_for(canonical));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each embedded const must be non-empty AND carry its `/NOTICE` attribution
    // header — one assertion guards both a mis-pathed `include_str!` (would fail
    // to compile or come back empty) and a missing SAW attribution header.
    #[test]
    fn every_persona_is_embedded_and_attributed() {
        for content in [
            ARCHITECT, SECURITY, QA, DATA, DESIGN, DOCS, FRONTEND, BACKEND,
        ] {
            assert!(!content.trim().is_empty(), "a persona embedded as empty");
            assert!(
                content.contains("/NOTICE"),
                "every persona must reference /NOTICE for attribution"
            );
        }
    }

    // A representative alias for EACH canonical persona resolves to that persona's
    // embedded content.
    #[test]
    fn each_canonical_alias_maps_to_its_persona() {
        assert_eq!(persona_for_role("architect"), Some(ARCHITECT));
        assert_eq!(persona_for_role("arch"), Some(ARCHITECT));
        assert_eq!(persona_for_role("architecture"), Some(ARCHITECT));
        assert_eq!(persona_for_role("security"), Some(SECURITY));
        assert_eq!(persona_for_role("auth"), Some(SECURITY));
        assert_eq!(persona_for_role("qa"), Some(QA));
        assert_eq!(persona_for_role("test"), Some(QA));
        assert_eq!(persona_for_role("data"), Some(DATA));
        assert_eq!(persona_for_role("db"), Some(DATA));
        assert_eq!(persona_for_role("schema"), Some(DATA));
        assert_eq!(persona_for_role("design"), Some(DESIGN));
        assert_eq!(persona_for_role("ux"), Some(DESIGN));
        assert_eq!(persona_for_role("docs"), Some(DOCS));
        assert_eq!(persona_for_role("writer"), Some(DOCS));
        assert_eq!(persona_for_role("frontend"), Some(FRONTEND));
        assert_eq!(persona_for_role("fe"), Some(FRONTEND));
        assert_eq!(persona_for_role("ui"), Some(FRONTEND));
        assert_eq!(persona_for_role("backend"), Some(BACKEND));
        assert_eq!(persona_for_role("api"), Some(BACKEND));
        assert_eq!(persona_for_role("rust"), Some(BACKEND));
        assert_eq!(persona_for_role("tauri"), Some(BACKEND));
    }

    // The planner's freeform kebab-case roles (claim #7) canonicalize by token.
    #[test]
    fn fuzzy_kebab_roles_canonicalize() {
        assert_eq!(persona_for_role("frontend-ui"), Some(FRONTEND));
        assert_eq!(persona_for_role("backend-api"), Some(BACKEND));
        assert_eq!(persona_for_role("db-migration"), Some(DATA));
        assert_eq!(persona_for_role("qa-e2e"), Some(QA));
        assert_eq!(persona_for_role("ui-design"), Some(DESIGN));
        assert_eq!(persona_for_role("tech-writer"), Some(DOCS));
    }

    // Ambiguous multi-token roles resolve DETERMINISTICALLY by the fixed §C
    // precedence — never a panic, never a random pick.
    #[test]
    fn precedence_breaks_multi_token_ties() {
        // `data` (4) outranks `backend` (8): DB work is the more specific intent.
        assert_eq!(persona_for_role("data-api"), Some(DATA));
        assert_eq!(persona_for_role("db-migration"), Some(DATA));
        // `qa` (3) outranks `frontend` (7): a qa-of-frontend ticket is qa.
        assert_eq!(persona_for_role("qa-frontend"), Some(QA));
        // `security`/`architect` lead as cross-cutting concerns.
        assert_eq!(persona_for_role("auth-api"), Some(SECURITY));
        assert_eq!(persona_for_role("arch-review"), Some(ARCHITECT));
    }

    // Matching is case- and whitespace-insensitive (lowercase + tokenize + trim).
    #[test]
    fn matching_ignores_case_and_whitespace() {
        assert_eq!(persona_for_role("Backend_API"), Some(BACKEND));
        assert_eq!(persona_for_role("  QA "), Some(QA));
        assert_eq!(persona_for_role("FrontEnd"), Some(FRONTEND));
    }

    // A role with no matching token yields `None` -> no persona -> byte-identical
    // to a pre-Phase-4 spawn.
    #[test]
    fn unmatched_role_is_none() {
        assert_eq!(persona_for_role("misc"), None);
        assert_eq!(persona_for_role("foo-bar"), None);
        assert_eq!(persona_for_role(""), None);
        assert_eq!(persona_for_role("   "), None);
        assert_eq!(persona_for_role("---"), None);
    }

    // `CANONICAL_ROLES` (planner menu) and `ALIASES` (matcher) must stay aligned:
    // every canonical name is present in both, in the same order, and resolves to
    // a real (non-empty) persona. Guards a rename in one table but not the other.
    #[test]
    fn canonical_roles_align_with_the_matcher() {
        assert_eq!(CANONICAL_ROLES.len(), ALIASES.len());
        for ((role, _desc, _agent), (alias_key, _)) in CANONICAL_ROLES.iter().zip(ALIASES.iter()) {
            assert_eq!(role, alias_key, "CANONICAL_ROLES/ALIASES order drift");
            assert!(
                persona_for_role(role).is_some(),
                "canonical role `{role}` must resolve to a persona"
            );
        }
    }
}
