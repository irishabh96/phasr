# Phase 2 — Rich tickets (versioned briefs) + the Worklist home: Implementation Breakdown

**Mode:** story elaboration → implementation-ready. **Date:** 2026-07-20. **Author:** BSA.
**Roadmap:** [`velvety-sniffing-thompson.md`](/Users/rishabh/.claude/plans/velvety-sniffing-thompson.md)
— **Phase 2 (Rich tickets = versioned briefs)** + the **UX/Design** section + **Open decisions**, phasr's
evolution into a local AI software factory.
**Design contract (build to this):** `scratchpad/phasr-factory-pages.html` — the founder-approved page
mockups. **Page 01 "Worklist / Home"** and **Page 04 "Ticket detail — Brief tab"** are the two surfaces this
milestone builds. Tokens are transcribed verbatim from `src/index.css`; the discipline is preserved (only
STATUS carries semantic color; persona/role chips are neutral; coral is scarce = the single primary gate +
selection tint).
**Continuity:** [`phase1-planner-implementation.md`](./phase1-planner-implementation.md) (the Planner, just
shipped — the goal→board draft this phase enriches), [`task-board-p0-implementation.md`](./task-board-p0-implementation.md)
(the P0 gate/scheduler/integrate/handoff substrate), [`multi-agent-task-board-spec.md`](./multi-agent-task-board-spec.md)
(the MATB epic), [`step0-honest-status-implementation.md`](./step0-honest-status-implementation.md)
(the honest-status derivation reused for the worklist buckets).
This spec turns Phase 2 into files-to-touch, Given/When/Then AC, the frozen 3-place IPC contract, owners,
effort, build order, a full state matrix, and tests. Every load-bearing claim is checked against code
(`file:line`) in §0.

---

## 0. Validation Log (claims checked against code, before planning)

| # | Claim (from the brief) | Verdict | Evidence (`file:line`) |
|---|-------|---------|----------------------|
| 1 | Home (`/`) "force-navigates to the last workspace" | **CORRECTED — it is restore-with-fallback, not a naive force-nav** | `src/routes/_app/index.tsx` — `Home()` prefers the stored `lastWorkspace` **only when its repo still exists** (`storedRepoValid`), `Navigate`s to it if the workspace still resolves; else falls to the newest workspace (`workspaces?.[0]`); else `RepoEmptyState`; zero repos → `WelcomeState`. So `/` is an *entry router*, never a dead-end. Phase 2 keeps the restore and inserts a `/worklist` fallback for users with no valid last-workspace (open decision #5). |
| 2 | Inner tabs are the structure to extend with Brief/Comments | **CONFIRMED — with one reconciliation** | Inner tabs live in `useUiStore.innerTabs[workspaceId]` as `InnerTab { kind: "main" \| "terminal" \| "preview" }` (`src/lib/store.ts:24-41`); rendered by `WorkspaceInnerTabBar.tsx` (the pill strip, roving-tab a11y `:47-66`) and `WorkspaceTabContent.tsx` (all tabs mounted, visibility toggled `:74-124`). **Reconciliation:** "Changes" is NOT an inner tab today — it is the right-side `<aside>` panel toggled by `ChangesToggle` (`$workspaceId.tsx:363-388`, `WorkspaceRightSidebar`). The mockup renders `Brief · Terminal · Changes · Comments` in one row; we add `brief`/`comments` as real inner tabs and keep Changes as the right-panel toggle (see A2). |
| 3 | `useFileDrop`/`usePromptDropTarget` are the drag-drop to reuse | **CONFIRMED — with a required extension** | `useFileDrop()` is a **shell-level singleton** (mounted once in `_app.tsx:67`) subscribing to Tauri's native `onDragDropEvent` and routing dropped absolute paths to (1) a focused prompt textarea via `getPromptInsertTarget()`, else (2) the active workspace's agent PTY via `sendInputToTask` (`useFileDrop.ts:37-57`). `usePromptDropTarget` registers a caret-aware inserter via `setPromptInsertTarget` (`usePromptDropTarget.ts`). **Extension needed:** OS drops are intercepted at the webview level so HTML5 `onDrop` never fires (`useFileDrop.ts:22-25` comment) — the Assets zone therefore CANNOT use `onDrop`; it must register an **asset-drop target** in the same dispatch (new `assetDropTarget.ts` registry, mirror of `promptInsertTarget.ts`). See Story T5. |
| 4 | The scheduler seed-prompt is the hook for "agent reads its brief" | **CONFIRMED** | `augment_prompt(base, producer_suffix, consumer_prefix)` composes `[consumer_prefix][base][producer_suffix]` and is pure/unit-tested (`orchestrator/scheduler.rs:191-213`). It is called in `spawn_ready_subtask` (`orchestrator/service.rs:943-947`), which already has `repository_path`, `parent`, `subtask`, `role` in scope. Phase 2 adds a **brief pointer** segment (Story T3). |
| 5 | "where a cross-repo list would come from" | **FINDING — no cross-repo list exists; one must be added** | `list_workspaces(repository_id)` is per-repo (`commands/workspaces.rs:159-169`) → `store::list_by_repository_for_user` (`store/workspaces.rs:88`). `list_parents()` exists but is **NOT user-scoped** (`store/workspaces.rs:195-201`, `WHERE workspace_kind='parent'`, no `user_id`). `get_board_for_user(parent_id, user_id)` assembles one board (`store/board.rs:193-201`). **No command returns cross-repo attention data.** Phase 2 adds `list_worklist()` (Story T6) that reuses the existing per-repo methods server-side. |
| 6 | Storage: text + small images in-repo (versioned); large binaries in app-data with a ref | **CONFIRMED feasible; boundary validated** | Contracts already live **outside** every repo/worktree at `~/.phasr/tasks/<parent>/contracts/` (`scheduler.rs:71-91` `default_contract_root`) precisely so `prune_worktrees` can't delete them. Tickets are the *opposite* intent: **in the managed repo** at `<repo>/.phasr/tickets/<id>/` (git-versioned). Large binaries reuse the app-data pattern at `~/.phasr/ticket-assets/<id>/` with an in-repo ref. Both roots are reachable from `repository.local_path` + `$HOME`. |
| 7 | Reuse `deriveBoardState`/`deriveAgentState` for the worklist buckets | **CONFIRMED** | `deriveBoardState(subtask, board, liveness, now) -> { state, since }` is pure and covers `working\|idle\|wedged\|failed\|interrupted\|resolving\|stopped\|done\|blocked\|needs-review` (`src/lib/deriveBoardState.ts`); `deriveAgentState` (`src/lib/deriveAgentState.ts`) is the honest-status core it layers on. `boardColumn()` already maps state→lane. Phase 2 adds a sibling `worklistBucket()` (Needs-you / Running / Waiting / Recent). |
| 8 | Liveness must be available cross-repo for the worklist | **CONFIRMED — free** | `useTaskEvents()` is a **global** listener (mounted in `_app.tsx:65`) on the `phasr://task-status` stream that feeds the module store `agentLiveness.ts` (`setAgentLiveness`); `useAllAgentLiveness()` returns the full cross-repo map — already how `BoardView.tsx:59-67` reads liveness. The worklist reuses it verbatim; no per-repo poller wiring. |
| 9 | A Tauri file-picker dialog is available for click-to-pick | **CONFIRMED** | `tauri-plugin-dialog = "2"` (`src-tauri/Cargo.toml:20`) + `@tauri-apps/plugin-dialog@^2.7.1` (`package.json:35`), plugin initialised (`lib.rs:38`). `open({ multiple:true, filters:[…] })` returns absolute paths for `add_ticket_asset`. |
| 10 | Referenced UI primitives exist | **CONFIRMED** | `GlassTextarea` (`ui/GlassInput.tsx:44`, `forwardRef`), `PanelState` (`ui/PanelState.tsx` — loading/empty/error with `action`/`onRetry`), `GlassSelect` (`ui/GlassSelect.tsx`), `Dialog` + `ConfirmDialog` (`ui/Dialog.tsx:47`,`:148-165`, danger + pending states). No `MergeBanner` exists (the plan's phrase) — the closest honest-prompt precedent is `MergeToMainDialog.tsx` + the `ChangesPanel` conflict surface; the "section changed on disk" prompt is a **new** inline banner styled to that family. |
| 11 | A markdown renderer is available for read-first briefs | **FINDING — none; add one** | Only `shiki@4.1.0` (code highlighting) is present (`package.json`), no markdown parser. Phase 2 adds `react-markdown` + `remark-gfm` for the read-mode brief; edit-mode is plain `GlassTextarea`. See D1. |
| 12 | The Phase 1 planner drafts `prd.md`/`trd.md` onto each ticket | **CORRECTED — not yet; Phase 2 scaffolds, drafting is an additive Phase 1 follow-up** | The shipped planner returns `ProposedPlan = { subtasks: SubtaskInput[{role,agent,prompt}], edges }` (`phase1-planner-implementation.md` §A3) — no PRD/TRD. Phase 2 **scaffolds** the ticket folder (with `ticket.md` = the subtask prompt, empty `prd.md`/`trd.md` templates) at `start_decomposition` so briefs exist before spawn (Story T2); the planner *drafting* real PRD/TRD is a small additive extension flagged as a forward hook (§Forward hooks). |

**Net:** two brief claims are sharpened (Home is restore-with-fallback, not force-nav; the planner does not yet
draft PRD/TRD) and three gaps are surfaced (no cross-repo list command; the file-drop dispatch needs an
asset-target; no markdown renderer). None changes scope; each is folded into a story below.

---

## A. Architecture decisions (`#PATH_DECISION`)

**A1 — Tickets are in-repo, versioned; the file-service is the single writer.** Each ticket owns a folder in
the *managed* repo: `<repo.local_path>/.phasr/tickets/<ticketId>/` where `ticketId == subtask workspace id`.
A Rust **tickets file-service** (`src-tauri/src/tickets/mod.rs`, pure-ish fs I/O) is the ONLY reader/writer of
this layout; commands (`commands/tickets.rs`) are thin wrappers over it. The brief ships in the repo's git
history (the "docs never drift from code" thesis). `#EXPORT_CRITICAL`: the file-service NEVER escapes the
ticket dir — every path is `<repo>/.phasr/tickets/<sanitised id>/…`; reject `..`/absolute traversal in
`ticketId`/`section`/`assetId` (unit-tested).

**A2 — Brief + Comments are new inner-tab kinds; Changes stays the right-panel.** We add `brief` and
`comments` to `InnerTabKind` (`store.ts:24`). For a **subtask** workspace, `ensureInnerTabs` seeds
`[brief, main, comments]` with **`brief` active by default** (mockup Page 04); `brief`/`comments` are
non-closable. For `agent`/`local` workspaces the seed is unchanged (`[main]`) — the single-agent flow stays
byte-identical (plan: "existing agent/local workspaces are untouched"). **Changes is NOT refactored into a
tab** (it is a resizable `<aside>` with live git-watch; turning it into a tab is out of scope and risky).
The tab strip renders `Brief · Terminal · Comments` and the existing `ChangesToggle` sits in the header at the
strip's right edge, so the visible order reads `Brief · Terminal · Changes · Comments` as the mockup shows —
without moving the panel. (Alternative — Changes as a real tab — rejected: it would remount the git-watcher on
every tab switch and lose the resizable review pane.)

**A3 — The agent reads its brief via an absolute main-repo path (mirrors the contract pattern).** The seed
prompt points the agent at `<repo>/.phasr/tickets/<id>/prd.md`, `trd.md`, `figma.json`, `assets/` — absolute
paths OUTSIDE its worktree, exactly like the published-contract file lives outside worktrees (`scheduler.rs`
rationale). This is **always-current** (no commit needed at spawn) and safe (a fresh worktree only sees
*committed* files; the brief is authored on the main checkout at decompose time and may be uncommitted).
Committing the brief into the PR (so it ships with the code) is a **Phase 3** concern (at Validate/PR time).
(Alternative — commit-to-base-before-spawn so it lands in the worktree — rejected for Phase 2: it mutates the
user's git history at decompose time and couples spawn to a commit.)

**A4 — The worklist reuses the derive layer; the backend only *joins* cross-repo.** Bucketing is a pure
frontend derivation (`deriveBoardState`/`deriveAgentState` + a new `worklistBucket`), the single source of
truth for state — identical to how the board derives lanes. The new `list_worklist()` command does the
**cross-repo join** once (repos × their boards × loose agents) and returns raw material; it computes NO state.
This keeps "what's true" defined in exactly one place and honest (`blocked`/`needs-review` never become stored
`WorkspaceStatus` — plan invariant).

**A5 — Home = restore on launch, worklist on intent.** `/` stays the entry-router (restore the real
last-workspace for muscle memory, open decision #5); a new `/worklist` route is the cross-repo attention home.
A permanent sidebar **Home** entry + a `⌘⇧H` shortcut always jump to `/worklist` (explicit intent). New users
(no valid last-workspace) fall through `/` to `/worklist` instead of a bare repo empty-state.

**A6 — Co-editing is honest, never locked (open decision #6 = warn).** Three signals, in ascending cost:
(1) an ambient **"Agent is working from this brief"** banner derived purely from the workspace's running agent
state (no backend); (2) an on-disk-change **"section changed · [Reload] / [Keep mine]"** inline prompt driven
by a `watch_ticket` fs-watcher + an mtime guard on save; (3) per-section **"last edited by agent/you · Ns ago"**
from a local `.meta.json` authorship sidecar. Edits always save (warn, not block).

---

## B. Storage model — `.phasr/tickets/<id>/` (versioned brief)

```
<repo.local_path>/.phasr/tickets/<ticketId>/
├── ticket.md         # H1 title + Description body (the "Description" section)
├── prd.md            # Product requirements (planner-drafted / human-edited)
├── trd.md            # Technical requirements (planner-drafted / human-edited)
├── figma.json        # [{ id, url, label, addedBy:"you"|"agent", addedAt }]
├── comments.jsonl    # append-only; 1 JSON object per line (see TicketComment)
├── assets/           # in-repo copies: images / PDF / small binaries (versioned)
└── .meta.json        # LOCAL-ONLY: per-section { by:"you"|"agent", at } authorship  (gitignored)

<repo.local_path>/.phasr/tickets/.gitignore   # contains: **/.meta.json   (briefs versioned; meta local)
~/.phasr/ticket-assets/<ticketId>/            # app-data: LARGE binaries (.fig/.mp4/.mov/.zip / >5 MB)
```

- **Section ↔ file map:** `description → ticket.md` (body after the H1), `prd → prd.md`, `trd → trd.md`.
- **Missing files are empty sections, never errors** — a fresh ticket with no `prd.md` returns
  `{ prd: { content: "", … } }`. The file-service is create-on-write.
- **Asset placement (open decision #1):** ext ∈ {`.fig`,`.mp4`,`.mov`,`.zip`} OR size > `LARGE_ASSET_BYTES`
  (5 MiB) → copy to `~/.phasr/ticket-assets/<id>/` and record `{ storage: "app-data" }`; else copy into
  `assets/` and record `{ storage: "in-repo" }`. Both surface identically in `TicketAsset` with a resolvable
  `path`. `.meta.json` and app-data large binaries are the only non-versioned bits.
- **Figma (open decisions #2, #10):** link-only v1 — `figma.json` stores the URL + a label; the FE renders a
  neutral link chip with a placeholder thumbnail. oEmbed/Dev-Mode MCP is Phase 5.

---

## C. Frozen IPC contract (3-place: Rust command · `tauri.ts` wrapper · `types.ts` DTO)

> Every command is registered in `src-tauri/src/lib.rs` `invoke_handler`, wrapped in `src/lib/tauri.ts`, and
> its DTOs mirrored in `src/lib/types.ts`. Field names are `camelCase` on the wire (serde rename matches the
> existing `Workspace`/`BoardState` convention). **This contract is frozen for the milestone.**

### C.1 — Tickets file-service (owner: **tauri-engineer**) — `commands/tickets.rs`

```
read_ticket_brief(repositoryId: string, ticketId: string) -> TicketBrief
write_ticket_section(repositoryId: string, ticketId: string, section: BriefSection,
                     content: string, baseMtimeMs: number | null) -> WriteSectionResult
list_ticket_assets(repositoryId: string, ticketId: string) -> TicketAsset[]
add_ticket_asset(repositoryId: string, ticketId: string, sourcePath: string) -> TicketAsset
remove_ticket_asset(repositoryId: string, ticketId: string, assetId: string) -> void
add_ticket_figma_link(repositoryId: string, ticketId: string, url: string, label: string | null) -> FigmaLink
remove_ticket_figma_link(repositoryId: string, ticketId: string, linkId: string) -> void
list_ticket_comments(repositoryId: string, ticketId: string) -> TicketComment[]
add_ticket_comment(repositoryId: string, ticketId: string, body: string) -> TicketComment
watch_ticket(repositoryId: string, ticketId: string) -> void      // emits phasr://ticket-changed
unwatch_ticket(repositoryId: string, ticketId: string) -> void
```

```ts
// types.ts
export type BriefSection = "description" | "prd" | "trd";

export interface BriefSectionContent {
  content: string;              // raw markdown ("" when the file is missing)
  mtimeMs: number | null;       // on-disk mtime for optimistic-concurrency
  lastEditedBy: "you" | "agent" | null;   // from .meta.json
  lastEditedAtMs: number | null;
}
export interface TicketBrief {
  ticketId: string;
  title: string;                // H1 of ticket.md (falls back to workspace name)
  description: BriefSectionContent;
  prd: BriefSectionContent;
  trd: BriefSectionContent;
  assets: TicketAsset[];
  figma: FigmaLink[];
  commentCount: number;
}
export type WriteSectionResult =
  | { kind: "saved"; section: BriefSectionContent }
  | { kind: "conflict"; onDisk: BriefSectionContent };   // baseMtime stale → FE shows Reload/Keep-mine
export interface TicketAsset {
  id: string;                   // stable id (sanitised filename)
  name: string;
  storage: "in-repo" | "app-data";
  path: string;                 // absolute, resolvable for preview
  sizeBytes: number;
  kind: "image" | "pdf" | "binary";
  addedAtMs: number;
}
export interface FigmaLink { id: string; url: string; label: string | null; addedBy: "you" | "agent"; addedAtMs: number; }
export interface TicketComment {
  id: string;
  author: string;               // display name (signed-in user or agent label)
  authorKind: "you" | "agent";
  role: string | null;          // persona/role for agent comments
  body: string;
  createdAtMs: number;
}
export interface TicketChangedPayload { ticketId: string; sections: BriefSection[]; }  // phasr://ticket-changed
```

- `write_ticket_section`: if `baseMtimeMs != null` and the on-disk mtime is **newer**, return
  `{ kind: "conflict", onDisk }` and do NOT overwrite. On save, stamp `.meta.json` `{ by: "you", at: now }`.
- `add_ticket_comment`: author = signed-in user (`SessionState`), `authorKind: "you"`. Agent-authored comments
  are appended by the future `phasr` CLI (Phase 3); Phase 2 only reads them.
- `watch_ticket`: fs-watch the ticket dir (mirror `watch_workspace`, `commands/workspaces.rs:83-96`); on a
  change not caused by our own write, emit `phasr://ticket-changed` with the changed sections and stamp
  `.meta.json` `by: "agent"` for those sections (the only other writer).

### C.2 — Agent-reads-brief seed hook (owner: **tauri-engineer**) — `orchestrator/scheduler.rs` + `service.rs`

```rust
// scheduler.rs (pure, unit-tested) — NEW
pub fn brief_prompt_pointer(ticket_dir: &Path) -> String;   // "Your ticket brief: <dir>/prd.md, trd.md, figma.json, assets/…"
// augment_prompt SIGNATURE CHANGE (internal contract, not IPC):
pub fn augment_prompt(base: Option<&str>, brief: Option<&str>,
                      producer_suffix: Option<&str>, consumer_prefix: Option<&str>) -> Option<String>;
// composition order: [consumer_prefix (contracts)] [brief] [base] [producer_suffix]
```

- `spawn_ready_subtask` (`service.rs:943`) computes
  `ticket_dir = repository_path.join(".phasr").join("tickets").join(&subtask.id)`, best-effort
  `create_dir_all` (mirrors the contract-dir pre-create at `service.rs:930`), and passes
  `Some(brief_prompt_pointer(&ticket_dir))` when the ticket has content, else `None`.
- Phase 4 (persona) prepends its segment BEFORE `consumer_prefix`, keeping the documented final order
  `[persona][contracts][brief][base][producer]`.

### C.3 — Worklist cross-repo query (owner: **tauri-engineer**) — `commands/worklist.rs`

```
list_worklist() -> WorklistState
```

```ts
// types.ts
export interface RepoBrief { id: string; name: string; }
export interface WorklistState {
  repositories: RepoBrief[];    // for filter chips + repo-name labels
  boards: BoardState[];         // every epic (parent) for the signed-in user, cross-repo, WITH subtasks/deps/contracts
  looseAgents: Workspace[];     // agent/local workspaces NOT part of any decomposition (single-agent work)
}
```

- Implementation reuses existing user-scoped methods (no new store method strictly required): for the signed-in
  user, `list_repositories()` → per repo `list_by_repository_for_user`, partition into parents (assemble each
  via `get_board_for_user`) + loose agents (kind ∈ {`agent`,`local`}). A `list_parents_for_user(user_id)`
  store helper (mirror `list_parents`, `store/workspaces.rs:195`, add the `user_id` scope) is a **nice-to-have**
  tidy-up, not a blocker.
- `#EXPORT_CRITICAL`: user-scoped throughout (`session.require()` + `_for_user` reads) — a different account
  can never see another's boards (the invariant `get_board_for_user` already enforces, `store/board.rs:190-193`).

### C.4 — Home / restore (owner: **fe-developer**) — no new IPC

Reuses `list_repositories`, `list_worklist`, `useUiStore.lastWorkspace`. New `home` entry in
`src/lib/shortcuts.ts` (`⌘⇧H`, unused today — verified against the full registry in `shortcuts.ts`).

---

## D. Cross-cutting decisions

- **D1 — Markdown renderer.** Add `react-markdown` + `remark-gfm` (small, no network) for read-mode brief
  rendering; reuse the installed `shiki` for fenced-code highlighting if trivial, else plain `<pre>`. Edit-mode
  is a plain `GlassTextarea` (no live preview in v1). Bundle-size note: react-markdown is ~50 KB gzipped —
  acceptable for the marquee surface.
- **D2 — `<id>` = subtask workspace id.** The ticket folder is keyed by the subtask's workspace id (minted in
  `create_decomposition_inner`, `board.rs:329-345`), so the Brief tab reads
  `read_ticket_brief(repositoryId, ticketId = workspaceId)` with no extra mapping.
- **D3 — Vocabulary (open decision #8 = Epic → Ticket).** User-facing copy uses **Ticket** for a subtask and
  **Epic** for a parent across the worklist and brief; internal types stay `subtask`/`parent`.

---

## E. Stories (Given/When/Then AC · owner · effort)

### Epic P2 — Rich tickets + Worklist home
Two owners: **tauri-engineer** (T-stories, backend + seed hook) and **fe-developer** (F-stories, the two
surfaces). Stories are ordered by the build order in §F.

---

#### Story T2 — Scaffold the ticket folder at decomposition — **tauri-engineer** · S
**As** phasr, **I want** each subtask to get a `.phasr/tickets/<id>/` folder with a seeded `ticket.md` the
moment the epic is created, **so that** a brief exists before the agent spawns and the Brief tab always has
something to read.
- **Given** `start_decomposition` creates N subtask rows, **When** each row is minted
  (`create_decomposition_inner`, `board.rs:329-345`), **Then** the file-service scaffolds
  `<repo>/.phasr/tickets/<subtaskId>/` with `ticket.md` (H1 = subtask name, body = subtask prompt),
  empty-template `prd.md`/`trd.md`, an empty `figma.json` (`[]`), and writes `.phasr/tickets/.gitignore`
  (`**/.meta.json`) if absent.
- **Given** the repo has no `.phasr/` dir, **Then** it is created; scaffolding is idempotent (re-running never
  clobbers an existing `prd.md`/`trd.md` with content).
- **Given** scaffolding fails (permissions), **Then** decomposition still succeeds (best-effort, logged) — the
  Brief tab shows an empty-with-CTA state, never a hard failure.
- **Tests:** `cargo test` — scaffold creates the layout; idempotent re-run preserves edited content; path
  traversal in a crafted id is rejected.

#### Story T3 — Seed the agent's prompt with its brief pointer — **tauri-engineer** · S
**As** a subtask agent, **I want** my spawn prompt to name my brief files, **so that** I build against the
PRD/TRD/design instead of guessing.
- **Given** a ready subtask spawns (`spawn_ready_subtask`, `service.rs:888-947`), **When** the prompt is
  assembled, **Then** `augment_prompt` includes `brief_prompt_pointer(ticket_dir)` in position
  `[contracts][brief][base][producer]`, pointing at absolute `<repo>/.phasr/tickets/<id>/{prd.md,trd.md,figma.json,assets/}`.
- **Given** a subtask with an all-empty brief, **Then** the pointer is still included (the paths exist) but the
  base prompt is unchanged in spirit — an empty brief is not an error.
- **Given** the composition, **Then** the existing consumer-contract prefix and producer suffix still appear in
  their current order (regression-guarded).
- **Tests:** `cargo test` — `brief_prompt_pointer` output; `augment_prompt` 4-arg composition order across the
  matrix (base-only, +brief, +contracts, +producer, all-empty → `None`). **Manual smoke:** `read_task_log`
  shows the first prompt carrying `[contracts][brief][base]`.

#### Story T4 — Tickets file-service + read/write/section commands — **tauri-engineer** · L
**As** the FE, **I want** commands to read the whole brief and write one section with conflict detection, **so
that** the Brief tab renders and edits safely.
- **Given** `read_ticket_brief`, **When** called, **Then** it returns `TicketBrief` with each section's content,
  mtime, and `.meta.json` authorship; missing files → empty sections (never error); unknown ticket → an empty
  brief keyed by the id (still not an error, so a not-yet-scaffolded ticket is graceful).
- **Given** `write_ticket_section` with a `baseMtimeMs` equal to disk, **Then** it writes, stamps
  `.meta.json {by:"you"}`, returns `{kind:"saved"}`; **Given** a stale `baseMtimeMs`, **Then** it returns
  `{kind:"conflict", onDisk}` and does NOT overwrite.
- **Given** any command with a traversal id/section, **Then** it errors safely without touching the fs
  (`#EXPORT_CRITICAL`).
- **Tests:** `cargo test` — round-trip each section; missing-file→empty; stale-mtime→conflict;
  create-on-write; traversal rejection.

#### Story T5-BE — Assets + Figma + comments file-service — **tauri-engineer** · M
**As** the FE, **I want** to list/add/remove assets, add/remove Figma links, and read/append comments, **so
that** the Assets/Figma/Comments sections work.
- **Given** `add_ticket_asset(sourcePath)`, **When** the file is small/image/PDF, **Then** it is copied into
  `assets/` (`storage:"in-repo"`); **When** large/binary per the policy, **Then** into
  `~/.phasr/ticket-assets/<id>/` (`storage:"app-data"`); name collisions are de-duped; returns `TicketAsset`.
- **Given** `remove_ticket_asset`, **Then** the file is deleted from whichever store and the listing updates.
- **Given** `add_ticket_figma_link(url,label)`, **Then** it appends to `figma.json` with an id; `remove_…`
  deletes by id; a malformed URL is rejected with a humanizable error.
- **Given** `list_ticket_comments`/`add_ticket_comment`, **Then** comments read from `comments.jsonl` (one
  object/line, tolerant of a trailing newline) and append the signed-in user's comment (`authorKind:"you"`).
- **Tests:** `cargo test` — small vs large routing; collision de-dupe; figma add/remove; jsonl append + parse
  (including a malformed line skipped, not fatal).

#### Story T6 — `list_worklist` cross-repo query — **tauri-engineer** · M
**As** the FE, **I want** one call that returns every repo, every epic's board, and loose agents for the
signed-in user, **so that** the worklist buckets everything without N round-trips.
- **Given** the signed-in user, **When** `list_worklist()` runs, **Then** it returns `{ repositories, boards,
  looseAgents }` scoped to that user; a repo with no epics still appears in `repositories`; a repo with epics
  contributes assembled `BoardState`s (subtasks + deps + contracts).
- **Given** zero repos, **Then** `{ repositories: [], boards: [], looseAgents: [] }` (drives the empty state).
- **Given** a different account, **Then** it can never see another user's boards.
- **Tests:** `cargo test` — cross-repo aggregation shape; user-scoping isolation; empty case.

#### Story T7 — `watch_ticket` fs-watcher + change events — **tauri-engineer** · S
**As** the FE, **I want** a ticket-dir watcher that emits `phasr://ticket-changed`, **so that** an agent's
on-disk edits raise the "section changed" prompt.
- **Given** `watch_ticket(repositoryId, ticketId)`, **When** a section file changes on disk by something other
  than our own write, **Then** `phasr://ticket-changed { ticketId, sections }` is emitted and `.meta.json` is
  stamped `by:"agent"` for those sections; `unwatch_ticket` tears it down (mirror `watch/unwatch_workspace`).
- **Given** our own `write_ticket_section`, **Then** it does NOT self-trigger a spurious change event
  (debounce/own-write suppression).
- **Tests:** `cargo test`/manual — external edit → event; self-write → no event.

---

#### Story F1 — Worklist / Home surface (mockup Page 01) — **fe-developer** · L
**As** a user with work across repos, **I want** a calm "what needs me" home bucketed by attention, **so that**
I don't hunt through the sidebar tree.
- **Given** the new `/worklist` route + `useWorklist()` (`list_worklist`), **When** it renders, **Then** it
  shows four groups in order — **Needs you / Running / Waiting / Recent** — each row = `{ ticket name · persona
  chip · agent-type mark }` + a sub-line `{ repo · epic · branch/merge-target }` + a right-aligned honest
  status (mockup Page 01: "Wedged no output 8m", "Ready for review 3 changes", "Working active 12s", "Idle
  quiet 4m", "Blocked · waiting for backend", "merged into main / Done", "Stopped").
- **Given** each subtask, **Then** its bucket comes from `worklistBucket(deriveBoardState(subtask, board,
  liveness, now))`; loose agents from `worklistBucket(deriveAgentState(...))`; liveness from
  `useAllAgentLiveness()`. **Bucket map:** `wedged\|failed\|interrupted\|needs-review → Needs you`;
  `working\|idle\|resolving → Running`; `blocked → Waiting`; `done\|stopped → Recent`. **Only status carries
  color** (persona/agent-type neutral; coral only for selection).
- **Given** the filter chips (`All repos`, per-repo, `epic: …`) + search box, **Then** filtering/search is
  client-side over the derived rows (repo name, epic goal, ticket name, branch).
- **Given** keyboard focus in the list, **When** `j`/`k` pressed, **Then** selection moves down/up across the
  flat visible rows (roving `tabIndex`); `↵` opens the row (subtask → its ticket detail; loose agent → its
  workspace); `⌘K` opens the command palette. Focus-ring + `aria-selected` per existing conventions.
- **Given** a click on a row, **Then** it navigates to the same target as `↵`.
- **AC highlights:** every group with 0 items is hidden; the surface never shows all-empty without the
  first-run CTA (§ state matrix). `pnpm typecheck` + `pnpm test` green.

#### Story F2 — Home entry, shortcut, and `/` fallback — **fe-developer** · S
**As** a user, **I want** a permanent Home and a shortcut, **so that** the worklist is always one action away
while launch still restores my last workspace.
- **Given** the sidebar, **Then** a permanent **Home** entry (⌂, count badge = Needs-you count) sits above the
  Repositories nav (`AppSidebar.tsx:80` region) and navigates to `/worklist`; active on that route.
- **Given** `⌘⇧H`, **Then** it navigates to `/worklist` from anywhere (new `SHORTCUTS.home`).
- **Given** `/` on launch with a valid `lastWorkspace`, **Then** it restores it (unchanged, `index.tsx`); with
  NO valid last-workspace but ≥1 repo, **Then** it redirects to `/worklist` (was: newest-workspace/empty-state);
  zero repos → `WelcomeState` (unchanged).
- **AC highlights:** existing muscle memory preserved (open decision #5); no regression to
  `e2e/board-entry.spec.ts`.

#### Story F3 — Brief tab shell + read-first sections + section editor (mockup Page 04) — **fe-developer** · L
**As** a user on a ticket, **I want** Description/PRD/TRD as read-first markdown I can edit section-by-section,
**so that** I can shape the brief the agent works from.
- **Given** a subtask workspace, **Then** `ensureInnerTabs` seeds `[brief, main, comments]` with **brief
  active by default**; `brief`/`comments` are non-closable; `WorkspaceInnerTabBar`/`WorkspaceTabContent`
  dispatch the new kinds (`agent`/`local` seeds unchanged).
- **Given** the Brief tab, **Then** `BriefPanel` reads `useTicketBrief(repositoryId, workspaceId)` and renders
  **Description · PRD · TRD** as `react-markdown` (read-first) each with an **Edit** affordance (mockup Page
  04); Edit swaps the section to a `GlassTextarea` with **Cancel** / **Save ⌘↵**.
- **Given** a section save, **Then** it calls `write_ticket_section(baseMtimeMs)`; `{kind:"saved"}` updates in
  place; `{kind:"conflict"}` shows the inline **"section changed on disk · [Reload] / [Keep mine]"** prompt
  (Reload = take `onDisk`; Keep mine = re-save with the fresh mtime). Errors via `humanizeError`.
- **Given** the section header, **Then** it shows **"last edited by agent/you · Ns ago"** from
  `lastEditedBy`/`lastEditedAtMs` (omit the name when unknown — honest).
- **AC highlights:** read/edit is per-section (never a whole-doc editor); Brief default only for subtasks.

#### Story F4 — Co-editing honesty (banner + on-disk change) — **fe-developer** · M
**As** a user editing a brief while the agent runs, **I want** honest signals, **so that** I'm never surprised
or blocked.
- **Given** the ticket's agent is `working|idle|resolving` (from `deriveAgentState`), **Then** BriefPanel shows
  the ambient banner **"Agent is working from this brief. Your edits save now — it reads the brief again at its
  next step."** (warn, not lock — open decision #6).
- **Given** the Brief tab is open, **Then** it calls `watch_ticket` on mount / `unwatch_ticket` on unmount and
  subscribes to `phasr://ticket-changed`; an external change to a section NOT being edited soft-refreshes it;
  a change to a section being edited raises the **[Reload]/[Keep mine]** prompt (never a silent overwrite).
- **AC highlights:** the banner reuses the honest-status palette (warn), never coral; the prompt mirrors the
  `MergeToMainDialog`/conflict family, never a dead end.

#### Story F5 — Assets (drag-drop + picker) + Figma + Comments — **fe-developer** · L
**As** a user, **I want** to attach assets, link Figma, and thread comments, **so that** the brief carries
design context and discussion.
- **Given** the Assets section, **When** files are dropped anywhere while the Brief tab is active, **Then** the
  extended `useFileDrop` dispatch routes them to the registered **asset-drop target** (new `assetDropTarget.ts`
  + `useAssetDropTarget`), which calls `add_ticket_asset` per path; **precedence:** focused prompt-insert
  target → asset-drop target → active-workspace agent PTY (so the Brief's Assets zone wins over the terminal
  fallback while it's mounted).
- **Given** the "Drop images / PDFs or click to pick" zone, **When** clicked, **Then** the Tauri
  `open({multiple, filters})` dialog returns absolute paths → `add_ticket_asset`.
- **Given** an asset thumbnail, **Then** images render inline, PDFs/binaries show a typed chip; a remove
  affordance calls `remove_ticket_asset`.
- **Given** the Figma section, **When** "Add link" + a URL, **Then** `add_ticket_figma_link` stores it and a
  neutral link chip + placeholder thumbnail renders (link-only v1, open decisions #2/#10); remove by id.
- **Given** the Comments tab (`comments` inner tab, badge = `commentCount`), **Then** it lists
  `list_ticket_comments` (you vs agent styled distinctly, role shown for agents — mockup Page 04) and appends
  via `add_ticket_comment` (optimistic; roll back with `humanizeError` on failure).
- **AC highlights:** the asset-drop-target extension must NOT regress prompt-insert or terminal drop
  (`e2e`/manual); large binaries route to app-data transparently.

#### Story F6 — Full state coverage for both surfaces — **fe-developer** · M
**As** a user, **I want** every state to offer an action, **so that** I'm never in a dead end (see §G matrix).
- Worklist: loading (skeleton rows via `PanelState kind="loading"`), empty-no-repos (first-run: Add repo / New
  epic / Quick task CTA), empty-all-quiet (a calm "nothing needs you" with a link to the boards), error
  (`PanelState kind="error"` + retry), scale (repo filter + search stay usable at 100s of rows;
  virtualise/cap-with-"show more"), concurrency (live liveness updates re-bucket rows without reflow jank).
- Brief: loading, empty section (Edit CTA), not-yet-scaffolded ticket (empty brief + "draft with the planner"
  hint), write error, conflict (Reload/Keep-mine), agent-live banner, asset add failure, figma malformed-URL.
- **AC:** each state is exercised in `design-test.tsx` (per the plan's "all new states") and the mocked e2e.

---

## F. Build order (dependency-correct)

1. **T2 → T3** (backend, tauri-engineer): scaffold ticket folders + seed the agent prompt. Unblocks "docs
   exist + agent reads them"; independently smoke-testable via `read_task_log`.
2. **T4 → T5-BE → T7** (backend): the file-service (read/write/section), then assets/figma/comments, then the
   watcher. T4 is the FE's hard dependency for F3.
3. **T6** (backend): `list_worklist` — parallelisable with T4/T5; the FE's dependency for F1.
4. **F1 → F2** (frontend): the Worklist surface, then the Home entry/shortcut/`/`-fallback. Start once T6
   lands. (Design-build sequence step 1: "Worklist home" first.)
5. **F3 → F4 → F5 → F6** (frontend): Brief shell/editor, co-editing honesty, assets/figma/comments, then the
   state matrix. Start F3 once T4 lands. (Design-build sequence step 2: "Brief + upload".)
6. **Cross-place hygiene:** every new command lands in all 3 places (`lib.rs` handler + `tauri.ts` + `types.ts`)
   in the same PR; add each to `e2e/harness.ts`'s `invoke` switch (`harness.ts:330`) so the mocked suite stays
   green.

The plan's Phase 2 build sequence = worklist (F1/F2) then brief (F3–F6); the backend (T2–T7) is staged just
ahead of the FE stories that consume it.

---

## G. State matrix (every state offers an action)

| Surface | Loading | Empty | Error | Scale | Concurrency |
|---|---|---|---|---|---|
| **Worklist** | `PanelState loading` skeleton rows | no repos → first-run CTAs (Add repo / New epic / Quick task); all-quiet → "Nothing needs you right now" + link to boards | `PanelState error` + retry (query refetch) | 100s of rows → repo filter + search + virtualise/"show more"; buckets stay scannable | live `agentLiveness` re-buckets rows in place; a row that becomes `needs-review` jumps to "Needs you" without layout thrash |
| **Brief tab** | section skeletons | empty section → **Edit** CTA; unscaffolded ticket → empty brief + "draft with the planner" hint | `write_ticket_section` error → inline `humanizeError` + Retry (edit buffer preserved) | long PRD/TRD → scrollable section, edit stays anchored | agent-live banner; on-disk change → Reload/Keep-mine; two sections editable independently |
| **Assets** | — | "Drop images / PDFs or click to pick" | add failure → toast + zone stays | many assets → wrap grid, thumbnails lazy | drop during an active agent still routes to Assets (precedence) |
| **Comments** | list skeleton | "No comments yet — leave the first note" | append failure → optimistic rollback + `humanizeError` | long thread → scroll, newest anchored | agent comment arrives via re-read on `phasr://ticket-changed` |

---

## H. Testing strategy

**Rust (`cargo test`):** ticket-folder scaffold (idempotent, traversal-safe); `read_ticket_brief`
missing→empty; `write_ticket_section` save/stale-conflict; asset small-vs-large routing + de-dupe; figma
add/remove; jsonl comments append/parse (malformed line skipped); `brief_prompt_pointer` + 4-arg
`augment_prompt` composition order; `list_worklist` cross-repo shape + user-isolation + empty; `watch_ticket`
external-change→event, self-write→no-event.

**Frontend (`pnpm typecheck` + `pnpm test`):** `worklistBucket` mapping across every `BoardCardState`; the
worklist bucketing over a fixture board; BriefPanel section save/conflict reducer; asset-drop precedence unit.

**E2E (Playwright, extend the mocked harness):** add the new commands to `harness.ts:330`. New specs:
`e2e/worklist.spec.ts` (buckets render from a seeded `list_worklist`; filter/search; `j/k/↵` navigation; empty
states) and `e2e/brief.spec.ts` (Brief default tab for a subtask; read→edit→save fires `write_ticket_section`;
conflict prompt; asset add fires `add_ticket_asset`; comment append). **Run the FULL suite each time** — a
scoped run hid a regression in a prior milestone (memory: testing-blind-spots).

**Manual smoke (the real gate — mocked tests can't see native fs/PTY):** decompose an epic → confirm
`.phasr/tickets/<id>/` scaffolds on disk → open the Brief tab → edit PRD, Save → confirm `prd.md` changed on
disk → Start the agent → `read_task_log` shows the first prompt carrying the brief pointer → drop an image on
Assets → confirm it lands in `assets/` (small) or `~/.phasr/ticket-assets/` (large) → open the Worklist, confirm
cross-repo buckets and that a running agent shows under "Running", a wedged one under "Needs you".

---

## I. Files to touch (condensed)

**Backend (tauri-engineer):** NEW `src-tauri/src/tickets/mod.rs` (file-service), `commands/tickets.rs`,
`commands/worklist.rs`; CHANGED `orchestrator/scheduler.rs` (`brief_prompt_pointer` + 4-arg `augment_prompt`),
`orchestrator/service.rs:930-947` (compute `ticket_dir`, pass brief), `commands/board.rs:329-345`
(scaffold-on-create hook), `store/workspaces.rs` (optional `list_parents_for_user`), `lib.rs` (register
handlers + `.gitignore` seed).

**Frontend (fe-developer):** NEW `src/routes/_app/worklist.tsx`, `src/components/worklist/*` (WorklistView, row,
bucket, filter chips), `src/components/brief/*` (BriefPanel, SectionEditor, Assets, Figma, Comments,
AgentWorkingBanner, OnDiskChangePrompt), `src/components/PersonaChip.tsx` + `AgentTypeMark.tsx` (reuse the
`WorkspaceAgentToolbar` color map), `src/lib/deriveWorklist.ts` (`worklistBucket`), `src/lib/assetDropTarget.ts`
+ `src/lib/hooks/useAssetDropTarget.ts`, `src/lib/hooks/useTicketBrief.ts` + `useWorklist.ts`; CHANGED
`src/lib/store.ts` (`InnerTabKind += "brief"|"comments"`, subtask seed = `[brief,main,comments]`),
`WorkspaceInnerTabBar.tsx` + `WorkspaceTabContent.tsx` (dispatch new kinds), `src/routes/_app/index.tsx`
(`/worklist` fallback), `AppSidebar.tsx` (Home entry), `src/lib/shortcuts.ts` (`home` ⌘⇧H),
`src/lib/hooks/useFileDrop.ts` (asset-target precedence), `src/lib/tauri.ts` + `src/lib/types.ts` (all DTOs),
`src/routes/design-test.tsx` (all new states), `package.json` (`react-markdown` + `remark-gfm`).

---

## J. Open decisions (recommended defaults — not blocking)

1. **Asset storage split (plan #1).** *Default:* text + small images/PDF in-repo (`assets/`, versioned); large
   binaries (`.fig`/video/`.zip` or >5 MiB) → `~/.phasr/ticket-assets/<id>/` with an in-repo ref. Spec'd in B.
2. **Agent brief visibility (A3).** *Default:* seed an **absolute main-repo path** (always-current, no commit).
   *Deferred:* commit-into-PR at Validate/PR time (Phase 3), which also lands the brief in the worktree.
3. **Home on launch (plan #5).** *Default:* restore last workspace for existing users; new users → `/worklist`;
   Home entry + `⌘⇧H` always jump to the worklist.
4. **Brief edits during a live agent (plan #6).** *Default:* **warn** (ambient banner + Reload/Keep-mine), never
   block or queue.
5. **Figma depth (plan #2/#10).** *Default:* **link-only** v1 (URL + label + placeholder thumbnail); oEmbed /
   Dev-Mode MCP is Phase 5.
6. **Changes as a tab vs right-panel (A2).** *Default:* keep Changes as the right-panel toggle; render it in the
   header at the strip's right so the visible order matches the mockup. *Escalate to founder* only if they want
   Changes to become a true swappable tab (bigger refactor).
7. **`.meta.json` authorship sidecar.** *Default:* **local-only** (gitignored) — editorial "who/when", not part
   of the versioned brief. *Alternative:* version it if authorship should appear in the PR (not v1).
8. **Markdown dependency (D1).** *Default:* add `react-markdown` + `remark-gfm`; edit-mode is plain
   `GlassTextarea` (no live preview v1).
9. **Vocabulary (plan #8).** *Default:* user-facing **Epic → Ticket**; internal types unchanged.

---

## Forward hooks (explicitly out of scope, wired for later)

- **Planner drafts PRD/TRD (Phase 1 additive).** Phase 2 scaffolds empty templates; enriching the planner to
  return optional `prd`/`trd` per subtask (written by T2's scaffold) is a small additive change to
  `ProposedPlan` — the file-service and Brief tab already render whatever is on disk.
- **Agent writes comments / edits the brief via the `phasr` CLI (Phase 3).** Phase 2's `comments.jsonl` +
  `watch_ticket` + `.meta.json` `by:"agent"` stamping are the read side; the CLI is the write side.
- **Commit the brief into the PR (Phase 3).** The in-repo layout makes "docs ship with code" a `git add` at
  Validate/PR time — no schema change.
- **Persona chip content (Phase 4).** `PersonaChip` renders the role now; the persona *taxonomy* + default
  agent-type (plan open decisions #9) is finalised when SAW personas are bundled.

## Architect Stage-1 corrections (REQUIRED before implementation — GO is conditional on these)
1. **Honesty (bug fix).** The agent is **READ-ONLY** on the brief in Phase 2 (agent writes are Phase 3, via the `phasr` CLI). The `watch_ticket` / `.meta.json` must **not** stamp external changes `by:"agent"` — the real external writer is the human's editor or git. Attribute unverifiable external edits **neutrally** (`by: null` / "changed on disk"); reserve `by:"agent"` for Phase 3.
2. **Single-source-of-truth + conflict robustness.** State the invariant: in Phase 2 there is exactly ONE physical copy per ticket file — the **main checkout**. The subtask worktree never materializes it (uncommitted/untracked → invisible; the agent reads via the absolute main-repo path, A3), so cross-checkout divergence does not occur in Phase 2. mtime alone is race-prone → **hash-assist**: on an mtime mismatch, compare a content hash before returning `conflict` (byte-identical ⇒ `saved`, no spurious prompt); record last-written `(path, hash)` and suppress the watcher's own-write events by hash. (Phase-3 commit-into-PR breaks the single-copy invariant → git-merge reconciliation; flag, out of scope.)
3. **Asset-drop correctness.** Register the asset-drop target when the Brief tab becomes **ACTIVE/visible**, clear on hide — **not on mount** (all inner tabs mount simultaneously; a hidden Brief must not hijack drops, and two open workspaces must not cross-route to the wrong ticket). Brief section editors (`GlassTextarea`) do **not** register as a `promptInsertTarget`, so a drop while editing attaches an asset (not a path string).
4. **Markdown security (CSP is `null`).** `react-markdown` with **no raw HTML** (its default — keep it) + add **`rehype-sanitize`** (strict schema) + constrain link/image protocols (block `javascript:`/`data:` beyond images; open external links via the shell plugin). Set a real CSP in `tauri.conf.json` (at least `script-src 'self'`) — the markdown surface (agent- + human-authored, full IPC bridge access) is the trigger.
5. **Plumbing + line refs.** Thread `RepositoryRepo` into `start_decomposition` / `create_decomposition_inner` for `repository.local_path` (the T2 scaffold hook); skip scaffolding when there is no `local_path`. Resolve the T3/C.2 empty-brief pointer inconsistency → **always include the brief pointer once the dir is scaffolded** (an empty brief is not an error). The row-mint hook is `create_decomposition_inner` at **`board.rs:417-492`** (subtasks minted `:442-457`), not `:329-345`. Detect + soft-warn if the repo already gitignores `.phasr/`.

**Known limitation (record now):** the brief is **UNVERSIONED until Phase 3** — untracked files on the main checkout; a `git clean -fdx` / `git stash -u` destroys it (and the gitignored `.meta.json`). Phase 3 must introduce a phasr-owned commit/ref so the source of truth is durable before the commit-into-PR flow is designed on top of it.
