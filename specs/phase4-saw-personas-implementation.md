# Phase 4 — Fork/adapt SAW + role personas: Implementation Breakdown

> **Plan:** `~/.claude/plans/velvety-sniffing-thompson.md` → *Phase 4 — Fork + bundle SAW + role
> personas* + the *Confirmed architecture → "Method + role personas"* note (fork SAW, re-author its
> personas for phasr's stack, bundle as embedded resources, seed each subtask agent with its role
> persona, preserve SAW attribution — MIT, ByBren / J. Scott Graham).
> **Continuity:** builds directly on `specs/phase3-command-layer-implementation.md` (the `phasr` CLI
> segment + Validate/Review gates that already ride the prompt), `specs/phase2-rich-tickets-implementation.md`
> (the brief pointer segment + `tickets` file-service), and `specs/phase1-planner-implementation.md`
> (the planner, its capability menu, and freeform kebab-case `role` per subtask).
> **Vocabulary:** user-facing **Epic → Ticket**; internally still `workspaceKind: "parent" | "subtask"`
> and a per-subtask `role: String`. "Persona" = the role's stack-aware system-prompt guidance.

**Scope of Phase 4:** turn each subtask's freeform `role` into a *seeded persona* — a short,
stack-aware guidance block prepended to the agent's spawn prompt — sourced from a curated set of
phasr-authored personas (re-authored from SAW's stock Next.js/Clerk/Prisma template), **embedded in
the binary** (`src-tauri/resources/personas/*.md` via `include_str!`), mapped from `role` by a fuzzy
canonical matcher, and attributed via a root `NOTICE` + a per-file header. This is a **small,
additive prompt-composition + bundled-resources** phase: one new pure module (`personas.rs`), a
one-argument extension to `augment_prompt`, one wire-up line in `spawn_ready_subtask`, a few
prompt lines in the planner, and content authoring. **Zero** new IPC, DB, UI, or runtime plumbing.

---

## 0. Validation Log (claims checked against code, before planning)

| # | Claim (from the brief) | Verdict | Evidence (`file:line`) |
|---|-------|---------|----------------------|
| 1 | `augment_prompt` is now **4-arg** `(base, brief, producer_suffix, consumer_prefix)` and composes `[consumer_prefix (contracts)][brief][base][producer_suffix]` | **CONFIRMED** | `orchestrator/scheduler.rs:238-260` — signature `augment_prompt(base: Option<&str>, brief: Option<&str>, producer_suffix: Option<&str>, consumer_prefix: Option<&str>)`; body pushes `consumer_prefix → brief → base → producer_suffix`, collapses all-empty to `None`. The doc comment (`:230-237`) **already names Phase 4**: *"Phase 4's persona segment will prepend before `consumer_prefix`, keeping the documented final order `[persona][contracts][brief][base][producer]`."* |
| 2 | The composition point (where segments are built + `augment_prompt` is called) is `spawn_ready_subtask` | **CONFIRMED** | `orchestrator/service.rs:930` `async fn spawn_ready_subtask(...)`; `producer_suffix` built `:967`, `consumer_prefix` `:980`, brief (T3) `:993`, CLI segment folded into the brief slot `:1007-1011`, and the call at `:1013-1018`. The persona segment is built here and threaded as the new 5th arg. |
| 3 | The subtask's `role` is in scope at the composition point (the persona key) | **CONFIRMED** | `orchestrator/service.rs:940` `let Some(role) = subtask.role.clone() else { return Ok(()) };` — `role: String` is bound at the top of `spawn_ready_subtask`, before every segment is built, so `persona_for_role(&role)` composes with zero new plumbing. |
| 4 | The persona segment must be **agent-agnostic** (prefix, not `--append-system-prompt`) | **CONFIRMED** | `domain/agent.rs:69-79` `command()` — each agent's launch string differs (`claude --dangerously-skip-permissions`, `codex …`, `copilot --allow-all`, `gemini --yolo`, `opencode`); `--append-system-prompt` is Claude-only. The existing seeds (brief/CLI/contracts) all ride **inside** `{{prompt}}` via `interpolate_for_task` (`service.rs:1022-1023`), so a leading prompt prefix already works for every agent. Persona follows the same seam. |
| 5 | `.claude/agents/*.md` is dev-only and gitignored (NOT the product resources) | **CONFIRMED** | `.gitignore` line `.claude/` ignores the whole dir; the 13 files (`.claude/agents/{bsa,fe-developer,qas,system-architect,tauri-engineer,…}.md`) are the **Claude Code subagents that build phasr**, a `{{PROJECT_NAME}}`/Next.js/Clerk/Prisma SAW template (`fe-developer.md:1-30` references `patterns_library/`, `{{TICKET_PREFIX}}-XXX`). They are **NOT** shipped and **NOT** to be vendored verbatim. Product personas live in a **new tracked** path. |
| 6 | No `personas.rs`, no `NOTICE`, no `src-tauri/resources/` exist yet | **CONFIRMED** | `ls src-tauri/src/orchestrator/` → no `personas.rs`; `ls NOTICE` → absent; `ls src-tauri/resources` → absent. `git check-ignore src-tauri/resources/personas/backend.md src-tauri/src/orchestrator/personas.rs NOTICE` → **exit 1 (none ignored)** — all three new paths will be tracked. |
| 7 | The planner assigns a freeform kebab-case `role` per subtask (the persona key) | **CONFIRMED** | `orchestrator/planner.rs:314` `build_prompt` → the `## Roles` block (`:336-343`): *"Each ticket has a unique, kebab-case `role` … (e.g. `backend-api`, `frontend-ui`, `db-migration`, `qa`)."* Roles are **freeform**, not a closed set — so `persona_for_role` must **fuzzy-match** (`backend-api → backend`, `frontend-ui → frontend`, `db-migration → data`), never exact-match. |
| 8 | The planner already has an agent **capability menu** to extend (Story S4) | **CONFIRMED** | `planner.rs:334-335` renders `## Agents available` from `Agent::ALL` via `agent_strength(agent)` (`:371`, one-line blurb per agent). Story S4's role menu is additive beside it. |
| 9 | `include_str!` needs **no** `tauri.conf.json` bundle-resources entry | **CONFIRMED (compile-time embed)** | `include_str!` inlines the file into the `.rlib` at compile time — it is **not** a runtime-loaded resource, so `tauri.conf.json`'s `bundle.resources` is irrelevant. Precedent: the codebase already embeds guidance strings as Rust `&'static str` (`scheduler.rs:164-227` builders). No `Resolver`/path-at-runtime needed. |
| 10 | phasr's own `LICENSE` is MIT — compatible with vendoring SAW (MIT) under a `NOTICE` | **CONFIRMED** | `/LICENSE` — MIT, "Copyright (c) 2026 Phasr Contributors". SAW is MIT © J. Scott Graham / ByBren, LLC (`.claude/agents/README.md`). MIT permits derivative works provided the copyright + permission notice is retained → a root `NOTICE` + per-file header satisfies it. |

**Net:** every load-bearing claim holds. Two sharpen the design: **(7)** roles are freeform, so the
map is a *fuzzy canonical* matcher returning `Option` (unmatched roles → no persona, byte-identical to
today); **(1/2)** the wiring is already scaffolded — the 4-arg `augment_prompt` and its call site were
built *anticipating* this phase (the doc comment names it), so Phase 4 is a one-arg extension, not a
refactor.

---

## A. Architecture decisions (`#PATH_DECISION`)

### A1. Storage = compile-time embed via `include_str!` (NOT `.claude/agents`, NOT runtime resources)

`#EXPORT_CRITICAL` The personas are **product resources** shipped inside the app to seed subtask
agents in the *end user's* repo — a different thing from `.claude/agents/*.md` (the gitignored
dev-time subagents that build phasr, claim #5). New tracked layout:

```
src-tauri/resources/personas/
  frontend.md  backend.md  qa.md  security.md  docs.md  design.md  data.md  architect.md
src-tauri/src/orchestrator/personas.rs   # include_str! each file + persona_for_role()
NOTICE                                    # root attribution (Story S5)
```

Each is embedded with `include_str!("../../resources/personas/<name>.md")` (path relative to
`personas.rs` at `src-tauri/src/orchestrator/`: `../` → `src/`, `../../` → `src-tauri/`). **Why embed,
not runtime-load:** no path resolution across dev/bundle, no missing-file failure mode, no
`tauri.conf.json` change (claim #9); the persona set is small, static, and versioned-in-repo. **Why
not reuse `.claude/agents`:** gitignored (never ships), stock-SAW/wrong-stack, and 3–25 KB each (far
too long for a prompt prefix — see A4).

### A2. Persona = the LEADING prompt segment, agent-agnostic prefix

Extend `augment_prompt` to a 5th `persona: Option<&str>` arg, prepended **before** `consumer_prefix`,
yielding the plan's documented final order:

```
[persona] [consumer_prefix (contracts)] [brief (CLI+brief pointer)] [base] [producer_suffix]
```

It rides **inside `{{prompt}}`** exactly like every other seed (claim #4) — so it works for
`claude`/`codex`/`copilot`/`gemini`/`opencode` alike. We do **not** use `--append-system-prompt`
(Claude-only) or touch `agent.command()`. The persona string is terminated with the same
`\n\n---\n\n` separator the sibling segments use (`scheduler.rs:184,208`), assembled at the call site
(A2's `format!`), keeping `augment_prompt` a dumb concatenator.

### A3. `role → persona` = fuzzy canonical matcher returning `Option<&'static str>`

Because roles are freeform kebab-case (claim #7), `persona_for_role(role: &str) -> Option<&'static str>`
lowercases + tokenizes the role (split on non-alphanumeric) and maps any token to a canonical persona
by an alias table (C below). Unmatched → `None` → **no persona segment** → byte-identical to today's
spawn. Matching is **token-based** (not raw substring) so `frontend-ui` matches `frontend` *and* `ui`
without `backend` ever matching on a stray `end`. `architect` uses a prefix rule (`arch*`) so
`architecture`/`arch` both hit. First-match-wins in a fixed precedence order (C) to make a
multi-token role like `data-api` deterministic (→ **data** wins over `api`→backend; see C note).

### A4. Personas are **role-first + light phasr-stack hint + "inspect the repo"** — short

`#PLAN_UNCERTAINTY` The plan says "re-author for phasr's stack (Tauri/Rust/React/TS)". Taken
literally, a persona hardcoded to Tauri/Rust would mislead an agent working in phasr-on-*another*
repo. Resolution (recommended default, Open Decision #1): each persona is **role-first** (what this
role owns, its quality bar, its handoff discipline) with a **short phasr-stack hint** as the default
context (phasr dogfoods on itself — the primary consumer *is* the Tauri/Rust/React/TS repo) **plus an
explicit "inspect the codebase you're in and match its stack/conventions" clause** so it stays correct
on any repo. Target length: **~150–400 words** each (a prompt prefix, not a 15 KB subagent doc). This
keeps the stock-SAW harm out (their Clerk/Prisma/RLS specifics are actively wrong for phasr) while
honoring "stack-aware".

### A5. Attribution = root `NOTICE` + per-file header (SAW is MIT, ByBren / J. Scott Graham)

`#EXPORT_CRITICAL` These personas are a re-authored derivative of SAW's persona set (MIT). Compliance:
a root `NOTICE` naming SAW's copyright + MIT terms, and a short attribution header at the top of every
`resources/personas/*.md` (comment or front-matter) pointing at `/NOTICE`. `personas.rs`'s module doc
records the provenance so the seam is discoverable. phasr's own `LICENSE` (MIT, claim #10) is
compatible; `NOTICE` is the retained-notice vehicle MIT requires.

---

## B. Stories (Given/When/Then AC, owner, build order)

> Owners use the phasr agent taxonomy: **tauri-engineer** (Rust/backend), **tech-writer** (docs/attribution),
> **product-designer** (the `design` persona voice + persona-content review). Build order in §E.

### S1 — Author the curated phasr persona set (content) — owner: **tech-writer** (author) + **product-designer** (design persona + review); **tauri-engineer** (bundle)

Create `src-tauri/resources/personas/{frontend,backend,qa,security,docs,design,data,architect}.md` —
each re-authored per A4 (role-first, short, phasr-stack hint, "inspect the repo" clause) with the A5
attribution header. Content per persona in §C.

- **Given** the stock SAW personas are a Next.js/Clerk/Prisma template (claim #5),
  **When** the phasr set is authored, **Then** none reference Clerk/Prisma/RLS/Stripe/`withUserContext`
  and each names phasr's actual stack (Tauri 2 / Rust / React / TS) *as a hint*, not a hard requirement
  (`grep -Li "clerk\|prisma\|withUserContext" src-tauri/resources/personas/*.md` → all files).
- **Given** these are prompt prefixes, **When** any file is measured, **Then** it is ≤ ~400 words /
  ≤ ~3 KB (a prefix, not a subagent doc).
- **Given** MIT attribution is required (A5), **When** any persona file is opened, **Then** its first
  lines carry the SAW attribution header pointing at `/NOTICE`
  (`grep -L "NOTICE" src-tauri/resources/personas/*.md` → empty).
- **Given** each canonical persona name in §C, **When** the dir is listed, **Then** all 8 files exist
  with exactly those names (the `include_str!` targets in S2 must resolve).

### S2 — `personas.rs`: embed + `persona_for_role` fuzzy canonical map — owner: **tauri-engineer**

New `src-tauri/src/orchestrator/personas.rs`: `include_str!` each of the 8 files into a `&'static str`
const, and expose `pub fn persona_for_role(role: &str) -> Option<&'static str>` per A3/C. Register
`mod personas;` in `orchestrator/mod.rs` and `pub use personas::persona_for_role;` (mirroring the
`scheduler`/`validate` re-exports at `mod.rs:44-59`). Module doc records SAW provenance (A5).

- **Given** a role that canonicalizes (per C), **When** `persona_for_role` is called, **Then** it
  returns `Some(<that persona's embedded content>)`: `persona_for_role("frontend-ui")`,
  `"fe"`, `"ui"` → the frontend persona; `"backend-api"`, `"api"`, `"rust"`, `"tauri"` → backend;
  `"db-migration"`, `"db"`, `"data"` → data; `"qa"`, `"test"` → qa; `"security"` → security;
  `"docs"`, `"writer"` → docs; `"design"`, `"ux"` → design; `"architecture"`, `"arch"` → architect.
- **Given** a role with no matching token (e.g. `"misc"`, `"foo-bar"`, `""`), **When**
  `persona_for_role` is called, **Then** it returns `None` (byte-identical-to-today fallback).
- **Given** an ambiguous multi-token role (e.g. `"data-api"`), **When** matched, **Then** the fixed
  precedence in C decides deterministically (unit-tested) — never a panic, never a random pick.
- **Given** matching is case/format-insensitive, **When** `"Backend_API"` or `"  QA "` is passed,
  **Then** it still canonicalizes (lowercase + tokenize + trim).

### S3 — Persona seeding: extend `augment_prompt` + wire into `spawn_ready_subtask` — owner: **tauri-engineer**

Add `persona: Option<&str>` as the trailing (5th) param of `augment_prompt` (`scheduler.rs:238`),
pushed **first** in the body (before `consumer_prefix`). Update the existing two call sites: the tests
(`scheduler.rs:406,425`) gain a `None` persona arg; `spawn_ready_subtask` (`service.rs:1013`) builds
the persona segment from `role` and passes it.

At `service.rs` (beside the other segment builders, ~`:993`):
```rust
let persona = personas::persona_for_role(&role)
    .map(|p| format!("{}\n\n---\n\n", p.trim()));
```
then `augment_prompt(subtask.prompt.as_deref(), brief.as_deref(), producer_suffix.as_deref(),
consumer_prefix.as_deref(), persona.as_deref())`.

- **Given** `augment_prompt` gains the persona arg, **When** all five are `Some`, **Then** the output
  is exactly `[persona][consumer_prefix][brief][base][producer_suffix]` in that order (new unit test),
  matching the doc comment at `scheduler.rs:233-234`.
- **Given** persona is `None` (unmatched role), **When** `augment_prompt` runs, **Then** the output is
  **identical** to the pre-Phase-4 4-arg behavior (the existing two tests, now passing `None`, stay
  green — regression guard).
- **Given** a subtask whose `role` maps to a persona, **When** it is spawned, **Then** its persisted
  `prompt` (and the interpolated `{{prompt}}` command) begins with that persona's content followed by
  `\n\n---\n\n`, ahead of any contract/brief/CLI segment.
- **Given** persona is derived purely from `role` (independent of owner/CLI, claim #3), **When** the
  CLI is off (tests / ownerless row), **Then** the persona segment is still present — it does **not**
  gate on `PHASR_TOKEN` (unlike the CLI segment).
- **Given** an all-empty subtask with an unmatched role, **When** spawned, **Then** the prompt stays
  `None` (the collapse-to-null invariant at `scheduler.rs:256-259` is preserved).

### S4 — Planner awareness: present the canonical roles + default agent — owner: **tauri-engineer** (small)

Additive to `build_prompt` (`planner.rs:314`): after the `## Agents available` menu (`:334`), extend
the `## Roles` block (`:336`) to list the **canonical persona roles** (C) with a one-line description
+ a **suggested default agent** each, and instruct the planner to *prefer role names that map to these
personas* (kebab variants that canonicalize are fine — the matcher is fuzzy). Keep it advisory: the
planner still picks freely; an off-menu role simply gets no persona (S2 fallback). Optionally source
the list from `personas.rs` (a `pub const CANONICAL_ROLES: &[(&str, &str, Agent)]`) so the prompt and
the matcher never drift.

- **Given** the persona set in C, **When** `build_prompt` renders, **Then** every canonical role name
  (`frontend`, `backend`, `qa`, `security`, `docs`, `design`, `data`, `architect`) appears in the
  prompt (extend the existing `build_prompt` test at `planner.rs:542` that already asserts each agent
  id appears).
- **Given** the planner is told to prefer mapping roles, **When** it emits a plan, **Then** roles like
  `frontend-ui`/`backend-api` (which canonicalize) are the expected shape — no validator change
  (roles stay freeform kebab; the gate at `board.rs` is untouched).
- **Given** a suggested default agent per role, **When** the planner assigns, **Then** the suggestion
  is advisory only (no backend routing added; `Agent::from_str` set is unchanged).

### S5 — Attribution: root `NOTICE` + per-persona header — owner: **tech-writer**

Create `/NOTICE`: name phasr (MIT, `/LICENSE`), then the SAW attribution — the persona set is a
re-authored derivative of the Safe Agentic Workflow persona architecture, © J. Scott Graham
(@cheddarfox) / ByBren, LLC, MIT — with SAW's MIT permission notice retained. Ensure every
`resources/personas/*.md` header (S1) points back to `/NOTICE`, and `personas.rs`'s module doc records
the provenance (A5). Cross-link `NOTICE` from `README`/`docs` where third-party notices belong.

- **Given** MIT requires the retained notice, **When** `/NOTICE` is read, **Then** it contains SAW's
  copyright line (J. Scott Graham / ByBren, LLC) + the MIT permission notice.
- **Given** the per-file headers (S1) reference `/NOTICE`, **When** the repo is built, **Then**
  `/NOTICE` exists and is tracked (`git check-ignore NOTICE` → exit 1, claim #6).
- **Given** docs quality gates, **When** `NOTICE` + persona `.md` files land, **Then** they pass the
  repo's markdown lint (no new lint failures).

---

## C. Persona set + `role → persona` map

Eight canonical personas. Each `.md` is short (A4), phasr-stack-aware, "inspect the repo"-safe, and
attribution-headed (A5). The alias table drives `persona_for_role` (A3); **precedence is top-to-bottom
first-match** so multi-token roles resolve deterministically.

| Precedence | Canonical | Aliases / tokens that match | Suggested default agent | Persona focus (content brief for S1) |
|-----------|-----------|-----------------------------|-------------------------|--------------------------------------|
| 1 | **architect** | `architect`, `arch*` (prefix: `architecture`, `arch`) | `claude` (or `gemini` for large-context sweeps) | System design, boundaries/layering, ADR-style decisions, "propose before you build," cross-ticket contract shape. |
| 2 | **security** | `security`, `sec`, `authz`, `auth` | `claude` | Threat-model the change, secrets/permissions/input-validation, least-privilege, "flag stop-the-line risks." |
| 3 | **qa** | `qa`, `test`, `tests`, `qas`, `e2e` | `codex` (fast focused) or `claude` | Validate against AC, unit/integration/e2e coverage, run the checks, "verify, don't assume; report honestly." |
| 4 | **data** | `data`, `db`, `database`, `migration`, `schema`, `sql` | `claude` | Schema/migrations, data integrity, "never `db push` in prod; write reversible migrations." |
| 5 | **design** | `design`, `ux`, `ui-design`, `visual` | `claude` | UX/visual, design-token discipline, state coverage (empty/loading/error), a11y/contrast — the product-designer voice. |
| 6 | **docs** | `docs`, `doc`, `writer`, `documentation`, `tech-writer` | `claude` (or `gemini`) | Clear docs that ship with the code, "docs never drift from code," READMEs/changelogs. |
| 7 | **frontend** | `frontend`, `fe`, `ui`, `client`, `web` | `claude` (or `codex`) | React/TS components, reuse-before-create, existing UI conventions, honest loading/error states. |
| 8 | **backend** | `backend`, `be`, `api`, `server`, `tauri`, `rust`, `core` | `claude` | Rust/Tauri commands + layering (domain/store/git/pty/orchestrator), typed errors, "write the handoff contract dependents build against." |

**Matching precedence note (A3):** listing `data` (4) above `backend` (8) makes `db-migration` and
`data-api` resolve to **data** even though `api`→backend also matches — DB work is the more specific
intent. `qa` (3) above `frontend`/`backend` keeps `qa-frontend` a **qa** ticket. `architect`/`security`
lead because they are cross-cutting. Precedence is encoded as the iteration order of the alias table
and is unit-tested (S2). Unmatched → `None`.

---

## D. Testing strategy

All Rust; matches the plan's *Verification → "persona composition order"* line. Run the **full**
`cargo test` suite (a scoped run hid a regression in a prior session).

### Unit — `personas.rs` (S2)
- `persona_for_role` returns `Some` for a representative alias of **each** canonical persona (table C).
- Fuzzy: `frontend-ui`, `backend-api`, `db-migration`, `qa-e2e` map to `frontend/backend/data/qa`.
- Precedence: `data-api` → data; `qa-frontend` → qa (deterministic, no panic).
- `None` for `misc`, `foo`, `""`; case/whitespace-insensitive (`" Backend "`, `QA`).
- Each embedded persona const is non-empty and contains its `/NOTICE` attribution marker (guards a
  mis-pathed `include_str!` and a missing header in one shot).

### Unit — `augment_prompt` persona arg (S3)
- New: five-`Some` inputs compose exactly `[persona][consumer_prefix][brief][base][producer_suffix]`.
- Regression: the two existing tests (`scheduler.rs:406,425`), updated to pass `persona: None`, stay
  green — proving the `None` path is byte-identical to Phase 3.
- `persona=Some`, everything else `None` → the persona alone (a persona-only prompt is valid).

### Unit — planner (S4)
- Extend the `build_prompt` test (`planner.rs:542`) to assert every canonical role name appears.

### Manual smoke (the real gate — mocked tests can't see it)
- Decompose → Start → `read_task_log` the subtask's first prompt → confirm it opens with
  `[persona]` ahead of `[contracts][brief][base]` (the plan's smoke step, extended for persona).
- Run once against phasr's own repo (dogfood) to confirm a `backend`/`frontend` persona reads
  sensibly to a real agent.

---

## E. Build order (dependencies)

1. **S1** (author personas) — content first; S2's `include_str!` targets must exist to compile.
   Parallelizable across authors, but all 8 files must land before S2 builds.
2. **S5** (`NOTICE`) — parallel with S1 (tech-writer owns both); S1 headers reference it.
3. **S2** (`personas.rs` + `persona_for_role`) — depends on S1 (files) + S5 (header marker asserted
   in tests). Pure module; testable in isolation.
4. **S3** (`augment_prompt` + `spawn_ready_subtask` wire-up) — depends on S2 (`persona_for_role`).
   The one-line seam; the whole loop lights up here.
5. **S4** (planner awareness) — independent of S3's runtime path; depends on S2 only if it sources the
   role list from `CANONICAL_ROLES`. Can land last (or parallel with S3).

Critical path: **S1 → S2 → S3**. S4 + S5 fold in around it. One PR is reasonable (small phase); if
split, S1+S5+S2 (content + map, no behavior change) then S3+S4 (seeding + planner).

---

## F. Open decisions (recommended defaults — not blocking)

1. **Stack-locking vs. role-first (A4).** *Recommended:* role-first + short phasr-stack hint +
   "inspect the repo you're in" clause — correct on phasr's dogfood repo *and* any user repo. (The
   literal "hardcode Tauri/Rust" reading breaks phasr-on-another-stack.)
2. **`augment_prompt` arg position.** *Recommended:* append `persona` as the trailing 5th param
   (matches the brief's "tests gain a `None` persona arg" phrasing; minimal call-site churn — only 2
   sites) while pushing its content **first** in the body. Alternative (persona as the *first* param,
   reading top-to-bottom = composition order) is cleaner to read but reorders every call.
3. **Persona-only prompt.** A subtask with an empty base prompt but a matched role now spawns with the
   persona alone (no `None` collapse). *Recommended:* allow it — a persona is useful standalone; the
   planner rarely emits empty prompts anyway. (No change needed; just an acknowledged behavior.)
4. **Precedence for ambiguous roles (C note).** *Recommended:* the fixed order in C (`data`>`backend`,
   `qa`>`frontend`). If a future role reveals a bad tie-break, adjust the table — it's the single
   source of truth and is unit-tested.
5. **Sourcing the planner role menu (S4).** *Recommended:* a `CANONICAL_ROLES` const in `personas.rs`
   consumed by `build_prompt`, so the map and the prompt can't drift. Cheap; do it.
6. **Default-agent suggestions (C column).** Advisory only — no backend routing. *Recommended:* ship
   the suggestions in the prompt but don't enforce; revisit if the planner picks poorly.
7. **Persona set size.** Eight covers the plan's list. *Recommended:* ship 8; add `popm`/`rte`-style
   coordination personas only if a real ticket needs them (avoid speculative breadth).

---

## Cross-links

- Plan: `~/.claude/plans/velvety-sniffing-thompson.md` (Phase 4; "Method + role personas").
- Prior specs: `specs/phase3-command-layer-implementation.md` (CLI segment, gates),
  `specs/phase2-rich-tickets-implementation.md` (brief pointer, `tickets` file-service),
  `specs/phase1-planner-implementation.md` (planner, capability menu, freeform roles).
- Code seams: `orchestrator/scheduler.rs:238` (`augment_prompt`), `orchestrator/service.rs:930-1018`
  (`spawn_ready_subtask` composition), `orchestrator/planner.rs:314` (`build_prompt`),
  `domain/agent.rs:69` (`command()` — why prefix, not `--append-system-prompt`),
  `orchestrator/mod.rs:44-59` (re-export pattern for the new `personas` module).
