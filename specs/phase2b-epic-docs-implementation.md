# Phase 2b — Epic-level docs (PRD/TRD/Figma/assets) attached at epic creation, inherited by every task

**Mode:** requirements decomposition → implementation-ready. **Date:** 2026-07-23. **Author:** BSA.
**Correction to:** the Phase 2 per-ticket brief model
([`phase2-rich-tickets-implementation.md`](./phase2-rich-tickets-implementation.md)). Phase 2 stores docs
**per-ticket** (`<repo>/.phasr/tickets/<subtaskId>/{prd.md,trd.md,figma.json,assets/}`). The founder, testing
the real flow, found this backwards: **docs are an EPIC concern** — you write ONE PRD/TRD/Figma for the whole
initiative and every agent should inherit it, not re-attach it per task. This spec adds a **shared epic-doc
layer** and an **onboarding attach step**, and threads **inheritance** into every subtask's spawn prompt. The
per-ticket brief stays (ticket-specific detail); epic docs are the new SHARED layer above it.

**Continuity:** [`phase1-planner-implementation.md`](./phase1-planner-implementation.md) (goal→board draft,
the surface that gains doc attach), [`phase2-rich-tickets-implementation.md`](./phase2-rich-tickets-implementation.md)
(the per-ticket brief file-service this generalises), [`task-board-p0-implementation.md`](./task-board-p0-implementation.md)
(the gate/scheduler/spawn substrate), [`phase5a-autopilot-implementation.md`](./phase5a-autopilot-implementation.md)
(the per-epic autopilot toggle — confirms "epic" == `parent` workspace).

Every load-bearing claim is checked against code (`file:line`) in §0 before any planning.

---

## 0. Validation Log (claims checked against code, before planning)

| # | Claim (from the brief) | Verdict | Evidence (`file:line`) |
|---|------------------------|---------|------------------------|
| 1 | Docs are stored **per-ticket** today at `<repo>/.phasr/tickets/<subtaskId>/{prd.md,trd.md,figma.json,assets/}` | **CONFIRMED** | `tickets_root(repo) = repo/.phasr/tickets` (`src-tauri/src/tickets/mod.rs:300-302`); `ticket_dir` joins the sanitised **subtask id** (`:307-310`); the module doc states `ticketId == subtask workspace id` (`:3-8`). `scaffold_ticket` writes `ticket.md`/`prd.md`/`trd.md`/`figma.json`/`comments.jsonl` + `assets/` (`:347-369`). `BriefSection {Description,Prd,Trd}` → `ticket.md`/`prd.md`/`trd.md` (`:91-105`). |
| 2 | The epic-creation / onboarding flow offers **NO** way to attach docs or Figma | **CONFIRMED** | `DecomposeForm.tsx` is goal → planner → review(edit tickets) → "Start N agents" — the only fields are per-ticket `role`/`agent`/`prompt` + dependency edges (`src/components/DecomposeForm.tsx:212-453`, `TicketRow` `:481-617`). `toDecompositionInput` projects the draft to exactly `{repositoryId, parentPrompt, subtasks[{role,agent,prompt}], edges}` (`src/lib/decomposeDraft.ts:336-357`). The wire struct `DecompositionInput` has only those 4 fields (`src-tauri/src/commands/board.rs:79-84`; mirror `src/lib/types.ts:393-399`). No PRD/TRD/Figma/asset field anywhere in the create path. |
| 3 | An **epic** is a `parent` workspace with a stable server-minted id and NO worktree until integration | **CONFIRMED** | `create_decomposition_inner` mints `parent` with `workspace_kind = WorkspaceKind::Parent`, **NO branch/worktree/PTY** ("gets a branch/worktree only at integration") (`board.rs:500-506`); each subtask carries `parent_id = Some(parent.id.clone())` (`:520`). `WorkspaceKind::Parent` round-trips as `"parent"` (`domain/workspace.rs:64-76,227,232`). Autopilot/worklist already treat `parent` == "epic" (`commands/autopilot.rs:46-100`, `commands/worklist.rs:19,115`). |
| 4 | `augment_prompt` is how each subtask agent is seeded with its brief pointer | **CONFIRMED** | `brief_prompt_pointer(ticket_dir)` builds a "read these by absolute path" block naming `prd.md`/`trd.md`/`figma.json`/`assets/` (`scheduler.rs:195-207`); `augment_prompt(base, brief, producer_suffix, consumer_prefix, persona)` composes `[persona][consumer_prefix][brief][base][producer_suffix]` (`:240-266`). In `spawn_ready_subtask` the brief is built from **`subtask.id`** via `ensure_ticket_dir(&repository_path, &subtask.id)` (`service.rs:1023-1024`) and passed to `augment_prompt` (`:1052-1058`). |
| 5 | The spawn site has the **parent (epic) id** in scope for inheritance | **CONFIRMED** | `run_scheduler_tick` calls `spawn_ready_subtask(&plan.parent, subtask, …)` (`service.rs:892`); the fn signature is `spawn_ready_subtask(&self, parent: &Workspace, subtask: &Workspace, …)` (`:961-967`). So `parent.id` (the epic id) is directly available where the brief pointer is built — the exact injection point. |
| 6 | The per-ticket brief is **materialised into each subtask worktree** | **CORRECTED — it is NOT; it is read by absolute path on the MAIN checkout** | The file-service keeps "exactly ONE physical copy … on the main checkout; the subtask worktree **never materialises it**" (`tickets/mod.rs:13-21`); the pointer names paths "**OUTSIDE your worktree**, so read … directly by absolute path" (`scheduler.rs:189-207`). `git.rs` worktree creation copies **no** `.phasr` content (grep for `.phasr` in `orchestrator/git.rs` → empty). **So the correct inheritance mechanism is reach-by-absolute-path, not copy-into-worktree** (see A3). |
| 7 | Asset upload = a Tauri file dialog returning paths → an fs copy into the ticket | **CONFIRMED** | `open({multiple,filters})` from `@tauri-apps/plugin-dialog` returns absolute **paths** (`brief/BriefPanel.tsx:1,137-150`); `addTicketAsset(repoId,ticketId,path)` → `add_ticket_asset` (`commands/tickets.rs:159-176`) → `add_asset` which `std::fs::copy(source_path, dest)` into `assets/` (in-repo) or app-data for large binaries (`tickets/mod.rs:715-760,749`). Large-binary split at 5 MiB / `.fig .mp4 .mov .zip` → `~/.phasr/ticket-assets/<id>/` (`:592-598,615-619`). |
| 8 | Figma is **link-only v1**, persisted in `figma.json`, validated as `http(s)://` | **CONFIRMED** | `FigmaLink{id,url,label,addedBy,addedAt}` in `figma.json` (`tickets/mod.rs:225-233`); `add_figma_link` validates via `validate_figma_url` (`:851-860,865-888`); command `add_ticket_figma_link` (`commands/tickets.rs:203-216`). Open decision #5 in Phase 2 already scoped Figma to link-only. |
| 9 | Path-sanitisation rejects traversal before any fs touch | **CONFIRMED** | `sanitize_ticket_id` rejects empty/`.`/`..`/separators/absolute BEFORE any fs access (`tickets/mod.rs:315-327`); the same guard covers app-data dirs (`app_data_ticket_dir` `:603-609`) and asset ids (`sanitize_asset_id`). Reused verbatim by the epic store (E1). |
| 10 | Nothing persists until "Start N agents" (the B2 no-persist gate) | **CONFIRMED** | The whole draft lives in the `DecomposeForm` `useReducer`; "Nothing is created until you start." (`DecomposeForm.tsx:36-37,405-413`); the single write is `startDecomposition` (`:184`) → `start_decomposition` → `create_decomposition_inner` (`board.rs:239-260,485-567`). Epic docs must respect the same gate (see A2/E2/E3). |
| 11 | A CLI-added sibling ticket (`phasr new-ticket`) also scaffolds under the same parent | **CONFIRMED — and inherits for free** | `add_subtask_inner` builds a `Subtask` with `parent_id = parent_id` and calls the same `scaffold_ticket_folders` (`board.rs:670-697`). Because inheritance (E4) is computed at **spawn** from `parent.id`, a CLI-added sibling inherits the epic docs with **zero** extra wiring. |

**Net:** the brief's model is accurate except one premise correction — **claim 6**: the per-ticket brief is
*not* copied into worktrees; it is read by absolute path on the main checkout. Epic docs adopt the identical,
proven mechanism. Everything else is additive; no data migration is required.

---

## A. Architecture decisions (`#PATH_DECISION`)

### A1 — Epic docs live in a NEW sibling namespace `<repo>/.phasr/epics/<parentId>/`, served by the GENERALISED ticket file-service

Layout (mirrors a ticket folder exactly):

```
<repo.local_path>/.phasr/
├── tickets/<subtaskId>/{ticket.md, prd.md, trd.md, figma.json, comments.jsonl, assets/}   ← unchanged (per-ticket detail)
└── epics/<parentId>/{prd.md, trd.md, figma.json, assets/}                                  ← NEW (shared epic docs)
```

**Why a sibling `epics/` root, not `.phasr/tickets/<parentId>/`.** A parent IS a workspace with an id, so
`ticket_dir(repo, parentId)` would resolve and sanitise fine — but `.phasr/tickets/` is semantically *one
folder per subtask ticket*. Dropping an epic under it means (a) the per-ticket Brief tab and any future
`.phasr/tickets/*` enumeration would surface a stray "epic ticket" folder, and (b) the read/write surface
(`read_ticket_brief`) is keyed on subtask ids — an epic id there is a category error. A dedicated `epics/`
root keeps the two concerns cleanly separated with **zero collision risk** and no change to the existing
ticket surface. *(Alternative — reuse `tickets/<parentId>/` — rejected: semantic collision, no diff savings.)*

**Reuse, don't fork, the file-service.** The current `tickets/mod.rs` computes `tickets_root(repo) =
repo/.phasr/tickets` (`:300`) and everything else hangs off `ticket_dir`. Generalise by threading a **scope**
(the collection segment) through the small set of path-resolvers, so the epic store shares — byte-for-byte —
the same sanitisation (`sanitize_ticket_id` → `sanitize_id`), atomic write (`write_atomic`), figma
read/write (`read_figma`/`write_figma`/`validate_figma_url`), and asset copy/list (`add_asset`/`list_assets`,
incl. the 5 MiB app-data split). Concretely:

- Add `enum BriefScope { Ticket, Epic }` with `fn collection(self) -> &'static str` (`"tickets"` / `"epics"`).
- Change `tickets_root(repo)` → `scope_root(repo, scope)` = `repo/.phasr/<collection>`; `ticket_dir` becomes
  `doc_dir(repo, scope, id)`. Keep thin `ticket_dir`/`scaffold_ticket`/… wrappers that pass
  `BriefScope::Ticket` so **every existing caller and test is untouched** (Phase 2 stays byte-identical).
- Epic entry points are thin wrappers passing `BriefScope::Epic`: `epic_dir`, `ensure_epic_dir`,
  `scaffold_epic`, `write_epic_section`, `add_epic_asset`/`list_epic_assets`/`remove_epic_asset`,
  `add_epic_figma_link`/`remove_epic_figma_link`, `read_epic_brief`.
- App-data root for large epic binaries: `~/.phasr/epic-assets/<parentId>/` (sibling of `ticket-assets`),
  keyed by the parent id via the same `sanitize_id` guard.

This preserves the **`#EXPORT_CRITICAL` traversal guarantee for free** — the epic store cannot escape
`repo/.phasr/epics/<sanitised parentId>/` because it runs the identical pre-fs sanitiser.

`BriefSection` stays `{Description, Prd, Trd}`; the epic has **no `ticket.md`/description** (its "description"
is the epic's `parentPrompt`/goal, already on the parent row) — the epic writes only `prd.md`/`trd.md` +
`figma.json` + `assets/`. `read_epic_brief` returns `{prd, trd, figma, assets}` (no `description`/`comments`).

### A2 — Docs are attached during review, and WRITTEN only at "Start" (the no-persist gate holds)

The B2 gate ("Nothing is created until you start", claim 10) is load-bearing. The epic-brief attach surface
lives in the **review phase** of `DecomposeForm`, *above* the ticket list: the human has just seen the plan
and now writes the shared PRD/TRD + Figma link(s) + drops assets for the whole epic. Everything stays in the
draft (pure client state) until "Start N agents":

- **PRD / TRD** — two `GlassTextarea`s → held as `epicPrd` / `epicTrd` strings in the draft.
- **Figma link(s)** — a url+label input → held as `epicFigma: {url,label?}[]`.
- **Assets** — the Tauri `open()` dialog returns absolute **source paths** (claim 7); hold them as
  `epicAssetPaths: string[]` in the draft (a path is just a string — no copy happens until Start).

At Start these ride the extended `DecompositionInput` and the gate writes the epic folder synchronously
**before it returns** (E3), so the docs are on disk before the scheduler's next tick can spawn any subtask —
**closing the attach-vs-spawn race by construction** (no window where an agent spawns doc-less). *(Alternative
— attach on the board AFTER creation, reusing the Brief tab against the parent — rejected for the v1 attach
path: it reopens the no-persist gate and admits the spawn-before-docs race. It returns as the optional
edit-after-start surface, E5.)*

### A3 — Inheritance = an epic-docs pointer in the spawn prompt, read by absolute path on the main checkout

Corrects claim 6's premise. Just as the per-ticket brief is reachable (not materialised) at
`<repo>/.phasr/tickets/<subtaskId>/…`, epic docs are reachable at `<repo>/.phasr/epics/<parentId>/…` on the
main checkout — **outside** every worktree, always-current, no commit-at-spawn, no worktree mutation. In
`spawn_ready_subtask` we already have `parent: &Workspace` in scope (claim 5). We add an **epic-docs pointer**
built from `parent.id` and prepend it to the `brief` slot, so the composed prompt reads:

```
[persona] [consumer_prefix (contracts)] [epic-docs pointer] [per-ticket brief] [base prompt] [producer_suffix]
                                          └── SHARED (all tasks) ─┘ └ ticket-specific ┘
```

Epic docs come **first** in the brief slot (shared context the agent orients on), then the per-ticket brief
(the specific slice). New `scheduler::epic_docs_prompt_pointer(epic_dir)` mirrors `brief_prompt_pointer`,
naming `<repo>/.phasr/epics/<parentId>/{prd.md,trd.md,figma.json,assets/}` and telling the agent: *"Your
epic's shared PRD/TRD/design live here — read them first; your ticket's own brief is below."* Best-effort
`ensure_epic_dir(&repository_path, &parent.id)` guarantees the paths exist even for an epic with no docs
attached (empty file = "not written yet", never an error — mirrors the brief). **Because this is derived at
spawn from `parent.id`, every subtask inherits automatically — including CLI-added siblings (claim 11) and
re-decomposed tickets — with no per-ticket wiring.**

### A4 — Additive, no migration; per-ticket briefs stay

Epic docs are a **new shared layer**. The per-ticket `.phasr/tickets/<id>/` folders and the Brief tab are
untouched (they hold ticket-specific detail). An existing epic with no `.phasr/epics/<id>/` folder is
harmless: `ensure_epic_dir` creates it empty (or the pointer names empty files). No data migration, no schema
change (ticket/epic docs are on-disk, not DB rows — same rationale as `commands/tickets.rs:17-20`).

---

## B. Frozen wire contract (the 3-place delta)

Additive fields only; all optional so old callers still deserialize.

**`DecompositionInput`** (`board.rs:79-84`, `types.ts:393-399`, `decomposeDraft.ts:336-357`) gains:

```rust
pub struct DecompositionInput {
    pub repository_id: String,
    pub parent_prompt: String,
    pub subtasks: Vec<SubtaskInput>,
    pub edges: Vec<EdgeInput>,
    // ── NEW: epic docs, written at the gate (all optional) ──
    #[serde(default)] pub epic_prd: Option<String>,
    #[serde(default)] pub epic_trd: Option<String>,
    #[serde(default)] pub epic_figma: Vec<FigmaLinkInput>,   // { url, label? }
    #[serde(default)] pub epic_asset_paths: Vec<String>,     // absolute source paths, copied at the gate
}
```

**New commands** (E5, edit-after-start — thin wrappers, owner-scoped exactly like `commands/tickets.rs`):
`read_epic_brief(repositoryId, parentId) -> EpicBrief{prd,trd,figma,assets}`,
`write_epic_section`, `add_epic_asset`/`remove_epic_asset`, `add_epic_figma_link`/`remove_epic_figma_link`.
Owner boundary = the repo (`get_for_user`), identical to the ticket surface.

**No change** to `ProposedPlan` (the planner still returns only subtasks+edges; auto-drafting epic PRD/TRD is
OD9, deferred).

---

## C. Stories (Given/When/Then AC · owner · effort · build order)

Owners: **BE** = tauri-engineer (Rust/Tauri), **FE** = frontend/product-designer (React), **QAS** = tests.

### E1 — Generalise the file-service to serve an epic-doc store  · BE · M

**As** the platform, **I want** an epic-doc store at `<repo>/.phasr/epics/<parentId>/`, **so that** epic
PRD/TRD/Figma/assets have one traversal-safe home reusing the ticket store's guarantees.

- **Given** a repo checkout and a parent id, **when** `scaffold_epic(repo, parentId)` runs, **then** it
  creates `.phasr/epics/<parentId>/` with template `prd.md`/`trd.md`, empty `figma.json` (`[]`), and `assets/`
  — idempotent (never clobbers existing content), best-effort (a failure never fails the caller).
- **Given** a crafted `parentId` (`..`, a separator, absolute), **when** any epic entry point runs, **then**
  it errors via the shared `sanitize_id` **before any fs touch** (traversal guard preserved).
- **Given** the refactor, **when** the existing Phase-2 ticket suite runs, **then** it passes **byte-identical**
  (the `BriefScope::Ticket` wrappers keep `ticket_dir`/`scaffold_ticket`/… unchanged).
- **Given** a >5 MiB or `.fig/.mp4/.mov/.zip` epic asset, **when** added, **then** it routes to
  `~/.phasr/epic-assets/<parentId>/` (app-data), else into the in-repo `assets/` — same split as tickets.
- **Files:** `src-tauri/src/tickets/mod.rs` (add `BriefScope`, `scope_root`/`doc_dir`, `ensure_epic_dir`,
  `scaffold_epic`, `write_epic_section`, epic asset/figma wrappers, `read_epic_brief`, `EpicBrief`,
  `default_epic_assets_root`; rename `sanitize_ticket_id`→`sanitize_id` keeping a shim). Consider a rename to
  `src-tauri/src/briefs/` later; not required for v1.

### E2 — DecomposeForm gains an "Epic brief" attach section (no-persist)  · FE · M

**As** a founder starting an epic, **I want** to attach the shared PRD/TRD/Figma/assets in the review step,
**so that** every agent inherits them — without persisting anything until I click Start.

- **Given** the review phase, **when** it renders, **then** an "Epic brief" panel sits above the ticket list
  with: PRD textarea, TRD textarea, a Figma "url + label" add/remove list, and an asset picker
  (`open()` dialog) showing picked file names with a remove affordance.
- **Given** I edit any epic field, **when** I have not clicked Start, **then** nothing is written to disk
  (draft-only), and the footer still reads "Nothing is created until you start."
- **Given** I click "Start N agents", **when** the gate is invoked, **then** `toDecompositionInput` includes
  `epicPrd`/`epicTrd`/`epicFigma`/`epicAssetPaths` (trimmed; empty fields omitted).
- **Given** a planner failure (manual mode), **when** I hand-build the plan, **then** the Epic brief panel is
  still available (attach works on both paths).
- **Files:** `src/components/DecomposeForm.tsx` (Epic-brief section + picker via `@tauri-apps/plugin-dialog`),
  `src/lib/decomposeDraft.ts` (draft fields + `toDecompositionInput` mapping + validation: Figma urls
  `http(s)://`), `src/lib/types.ts` (`DecompositionInput` + `FigmaLinkInput`), `src/lib/tauri.ts` (no new
  binding — the extended input rides `startDecomposition`). Reuse `GlassTextarea`/`GlassInput`, and
  `FigmaSection`/`AssetsSection` styling where practical.
- **Depends on:** E3 (the input contract shape).

### E3 — The gate writes the epic docs (before it returns)  · BE · S

**As** the platform, **I want** `create_decomposition_inner` to persist the epic docs atomically-adjacent to
the parent write, **so that** docs exist on disk before any subtask can spawn.

- **Given** a `DecompositionInput` with epic fields, **when** the gate has written parent+subtasks+edges,
  **then** it `scaffold_epic` + writes `prd.md`/`trd.md` from `epicPrd`/`epicTrd`, appends each `epicFigma`
  link (validated), and `fs::copy`s each `epicAssetPaths` entry into the epic `assets/` — **before returning
  the board** (so it precedes the scheduler's first tick).
- **Given** any epic-doc write fails (permissions, missing checkout, bad path), **when** the gate runs,
  **then** it is logged and skipped — the decomposition still succeeds (best-effort, mirrors
  `scaffold_ticket_folders` `board.rs:557-563`).
- **Given** a repo with no `local_path`, **when** the gate runs, **then** epic-doc writing is skipped silently.
- **Files:** `src-tauri/src/commands/board.rs` (`DecompositionInput` fields; a `write_epic_docs(...)`
  best-effort hook after `create_decomposition` `:555`, before `get_board_for_user` `:566`).
- **Depends on:** E1.

### E4 — Every subtask inherits the epic docs via its spawn prompt  · BE · S

**As** an agent on any task, **I want** my prompt to point at the epic's shared PRD/TRD/design, **so that** I
build against the same source as my siblings.

- **Given** a ready subtask under parent `P`, **when** `spawn_ready_subtask` builds the prompt, **then** it
  prepends an epic-docs pointer naming `<repo>/.phasr/epics/<P.id>/{prd.md,trd.md,figma.json,assets/}`
  (absolute, main-checkout), ahead of the per-ticket brief.
- **Given** an epic with no docs attached, **when** a subtask spawns, **then** `ensure_epic_dir` makes the
  paths exist and the pointer still rides (empty file = "not written yet", never an error).
- **Given** a CLI-added sibling (`phasr new-ticket`) or a re-decompose, **when** it spawns, **then** it
  inherits the SAME epic pointer with no extra code (derived from `parent.id`).
- **Given** the persona/contract/base composition, **when** the prompt is assembled, **then** order is
  `[persona][consumer_prefix][epic-docs][ticket-brief][base][producer_suffix]` and an all-empty prompt still
  collapses to `None` (unchanged `augment_prompt` contract).
- **Files:** `src-tauri/src/orchestrator/scheduler.rs` (`epic_docs_prompt_pointer`),
  `src-tauri/src/orchestrator/service.rs` (`spawn_ready_subtask`: build the epic pointer from `parent.id` via
  `ensure_epic_dir(&repository_path, &parent.id)`, prepend to the `brief` slot at `:1023-1050`).
- **Depends on:** E1.

### E5 — (Stretch, v1.1) Epic-brief edit surface on the board  · FE · M

**As** a founder mid-epic, **I want** to edit the epic docs after Start, **so that** I can refine shared
requirements agents re-read on their next run.

- Reuse the Brief-tab components (`SectionEditor`, `AssetsSection`, `FigmaSection`) pointed at the **parent**
  via the E-`read_epic_brief`/`write_epic_section`/… commands; surfaced on the epic/board header.
- Owner-scoped exactly like the ticket brief; conflict-aware writes reuse the `TicketWriteRegistry` pattern.
- **Files:** `src-tauri/src/commands/tickets.rs` (or a sibling `commands/epics.rs`) for the epic commands;
  `src/components/brief/*` reused; a board-level entry point. **Recommend as a fast-follow, not required for
  v1 inheritance.**
- **Depends on:** E1.

### E6 — Tests & validation  · QAS · S (spread across E1–E4)

- **E1:** epic scaffold creates the full layout; traversal id rejected pre-fs; large-asset app-data split;
  the whole Phase-2 ticket suite still green (byte-identical wrappers).
- **E3:** gate writes `prd.md`/`trd.md`/figma/assets under `.phasr/epics/<parentId>/`; best-effort on failure
  (decomposition still succeeds); no-checkout skip.
- **E4:** `epic_docs_prompt_pointer` names the absolute epic paths; a spawned subtask's stored prompt contains
  the epic block ahead of the ticket brief; a doc-less epic still spawns; a CLI sibling inherits.
- **E2 (FE):** `toDecompositionInput` carries epic fields; draft-only until Start; Figma url validation;
  manual-mode path.
- **Validate:** `yarn lint:md` (this spec), `cargo test` (Rust), `yarn test` (FE), `yarn lint && yarn type-check`.

**Build order:** **E1 → E4** (inheritance plumbing, lands independently pointing at possibly-empty epic docs)
**→ E3** (gate fills them) **→ E2** (FE attaches to the E3 contract) **→ E5** (edit surface, stretch). E6 rides
each. Rationale: E4 needs only E1 (`ensure_epic_dir`), so inheritance can ship and be verified before the
attach UI exists; E2 builds to the E3 wire shape (contract-first).

---

## D. Open decisions (with recommended defaults)

| # | Decision | Options | Recommended default |
|---|----------|---------|---------------------|
| OD1 | Epic-doc storage root | `.phasr/epics/<parentId>/` (sibling) **vs** reuse `.phasr/tickets/<parentId>/` | **`.phasr/epics/<parentId>/`** — no semantic collision with the per-subtask ticket store (A1). |
| OD2 | Onboarding UX point | attach-during-review, no-persist **vs** attach-after-creation (board) | **during-review** — keeps the B2 no-persist gate and closes the spawn-before-docs race (A2). |
| OD3 | Assets in onboarding | stage source paths + copy at gate **vs** defer assets to post-Start | **stage paths, copy at gate** — a picked path is just a string; preserves no-persist and one-shot Start (A2/E3). |
| OD4 | Keep per-ticket briefs? | keep (ticket detail) + epic shared layer **vs** fold all into epic | **keep both** — epic docs = shared source, ticket brief = specific slice; per-ticket Brief tab unchanged (A4). |
| OD5 | Pointer ordering | epic-docs before ticket-brief **vs** after | **epic-docs first** — shared context leads, ticket brief refines (A3). |
| OD6 | Worktree materialisation | read-by-absolute-path (main checkout) **vs** copy into each worktree | **absolute path** — matches the proven brief mechanism; always-current, no commit/worktree mutation (A3, claim 6). |
| OD7 | Commit epic docs into the PR (ship with code) | now **vs** defer to a Validate/PR phase | **defer** — same posture as per-ticket briefs today (a later phase commits at Validate/PR). |
| OD8 | Figma depth | link + optional pasted screenshot (asset) **vs** Dev Mode MCP | **link + screenshot**; **MCP deferred** (matches plan Open Decision #10 / Phase 2 #5). |
| OD9 | Planner auto-drafts epic PRD/TRD from the goal | yes **vs** human writes | **human writes v1** — auto-draft is an additive planner hook, deferred (forward hook). |
| OD10 | Edit-after-start surface (E5) | v1 **vs** fast-follow | **fast-follow** — inheritance (E1–E4) is the v1 must-have; editing is additive. |

---

## E. Forward hooks (out of scope, noted so v1 doesn't paint us in)

- **Planner drafting** epic PRD/TRD from the goal → prefill E2's textareas (OD9).
- **Commit epic docs into the PR** at Validate/PR so shared requirements ship with the code (OD7).
- **Figma Dev Mode MCP** for design tokens/measurements (OD8).
- **Epic-brief change-watch** (`phasr://epic-changed`) so an open E5 surface soft-refreshes on external edits,
  mirroring the ticket `watch_ticket`/T7 watcher.

---

## F. Success validation

```bash
# Docs quality (this spec)
yarn lint:md && echo "BSA SUCCESS" || echo "BSA FAILED"

# After implementation
cargo test -p phasr tickets:: scheduler:: board::     # E1/E3/E4 unit + gate tests
yarn lint && yarn type-check && yarn test             # E2 FE draft/mapping
```

**Manual demo (acceptance):** create an epic in `DecomposeForm`, attach a PRD + TRD + a Figma link + an
image in the review step, click Start; confirm `<repo>/.phasr/epics/<parentId>/` holds the docs; confirm each
spawned subtask's stored `prompt` contains the epic-docs pointer (absolute `.phasr/epics/<parentId>/…` path)
ahead of its per-ticket brief; run `phasr new-ticket` and confirm the sibling inherits the same pointer.
