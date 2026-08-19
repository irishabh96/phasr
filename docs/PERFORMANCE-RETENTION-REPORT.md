# Runtime Performance & Technical Retention Drivers for phasr

**Lens:** engineering / runtime. **Scope:** what makes phasr feel slow, janky, unstable, or lossy — the technical churn drivers for a keyboard-first developer tool. A parallel product-design report covers UX/onboarding/aesthetics; this one does not.

**Date:** 2026-07-12 · **Basis:** direct code read of the current working tree + measured `dist/` output. Analysis only; no code changed.

---

## Why this framing

For a developer desktop tool, retention is lost to a short list of technical failures, roughly in order of how fast they drive someone back to their old workflow:

1. **Crashes / data loss** — the trust-killers. One silently-discarded commit or one "✗ Failed to start" and the tool is untrustworthy.
2. **Large-repo slowdowns** — phasr's core users run AI agents that touch dozens–hundreds of files; the app must stay smooth exactly when the worktree is busiest.
3. **Jank during core loops** — expanding a diff, typing in the terminal, switching workspaces.
4. **Slow cold start** — the first impression, every session.

Every finding below is tagged with **Impact × Effort** so quick wins are separable from deeper work.

- **Impact:** High = directly drives churn / affects the core loop at realistic scale · Med = degrades experience · Low = polish.
- **Effort:** S ≈ hours–1 day · M ≈ 2–5 days · L ≈ 1–2 weeks.

---

## Executive summary

phasr's architecture is fundamentally sound — WAL SQLite with a pool, an fs-watcher instead of status polling, per-PTY blocking threads, route-level code splitting that already works, the previous engine writes that batch on rAF, and Zustand selectors used correctly. The problems are concentrated in a few places that happen to line up exactly with the app's heaviest real-world moment: **an AI agent actively rewriting a large worktree.**

The single highest-leverage cluster is the **Changes/diff pipeline (GIT-B2 and its neighbors).** When the Changes panel is open, phasr fetches the *full raw diff of every changed file* over IPC — even for collapsed cards — parses each on the React main thread, highlights up to ~40 eagerly, and then **re-does all of it on every filesystem tick** while the agent writes. Because `useGitStatus` is mounted three times for the same workspace, that storm is amplified 3×; because git shell-outs run **blocking on the Tokio runtime with no `spawn_blocking`**, a burst of them can stall the whole IPC layer (including terminal input); and because the fs-watcher is **recursive and gitignore-unaware**, an agent running `npm install`, a build, or a test loop fires the whole cascade continuously off `node_modules/`/`target/`/build output. Each `git_diff` is itself **two** subprocesses per file, so a 60-file change is ~120 blocking git spawns. This is an O(changed-files) cost repeated at multiple Hz during the exact workload phasr exists to serve.

The second cluster is **reliability of workspace restore and git integrity.** On relaunch, phasr marks running workspaces stopped and prunes git's worktree metadata, but never reconciles the database's `worktree_path` against reality — so a moved/deleted worktree yields `RepositoryPathMissing` → "✗ Failed to start" with no self-heal. Cloud sync copies `worktree_path` verbatim across machines (latent multi-machine break) and resolves conflicts by last-write-wins on `updated_at` (silent-overwrite surface). The per-repo write lock guards only *one* of the several code paths that mutate a shared `.git` (worktree-add in `start_task`), leaving `create_workspace` and `merge_to_main` unlocked — a real `index.lock`/refs-corruption surface. Workspace status updates are non-atomic read-modify-write (lost-update races), create/delete can orphan a worktree against its DB row in either direction, and ~60 orphaned worktree directories are never cleaned.

The third cluster is **cold-start and install size.** The first-paint entry chunk is 227 KB gz of app + Clerk + Sentry + Supabase parsed before anything renders; Shiki ships ~9 MB of language grammars to disk and compiles a 231 KB-gz Oniguruma WASM blob on the first diff. These are deferrable/trimmable with small, well-scoped changes.

None of these require re-architecture. The top five below are mostly S–M effort and target the moments that actually lose users.

---

## Top 5 highest-leverage items

| # | Item | Where | Impact × Effort |
|---|------|-------|-----------------|
| 1 | **Break the diff/watcher storm (GIT-B2 cluster)** — return line-counts from the status command so collapsed cards never fetch/parse a diff; fetch a file's raw diff only when its card expands; narrow `invalidateWorkspaceGit` to the changed file; mount the fs-watcher once per workspace (not 3×); and make the watcher gitignore-aware + coalesce `worktree-changed` so `node_modules`/build output can't trigger cascades. | `commands/git.rs`, `git/status.rs`, `ChangesPanel.tsx:569-605`, `useGit.ts:28-37,43-81`, `fswatch.rs:59-88` | **High × M** |
| 2 | **Take git shell-outs off the async runtime** — wrap `run_git` in `spawn_blocking` (or make it a blocking-pool call) and cap captured stdout size. Prevents a diff/status burst on a large repo from starving terminal input and sync. | `git/error.rs:21-34`, all `commands/git.rs` handlers | **High × S–M** |
| 3 | **Slim Shiki + stop re-tokenizing on the main thread** — switch to `shiki/core` + the JavaScript regex engine (removes the 231 KB-gz WASM compile and ~8 MB of grammar chunks) with a curated language set; memoize per-line tokens and drop the module-scope eager highlighter. | `lib/diff/shiki.ts`, `hooks/useShiki.ts`, `diff/DiffView.tsx:519-545` | **High × M** |
| 4 | **Make workspace restore self-healing** — recreate a missing worktree from its branch under the repo lock (or show a calm "not available on this machine" state) instead of failing; stop copying `worktree_path` verbatim from cloud; GC orphaned worktree dirs. | `orchestrator/service.rs:408-427`, `sync/mod.rs:353`, `git/worktree.rs` | **High × M** |
| 5 | **Defer cloud SDKs off first paint + add a real Vite build config** — lazy-init Sentry/Supabase after first render; add `build.target: 'es2022'`, `manualChunks`, and `sourcemap`. Cuts the 227 KB-gz entry parse on every cold launch. | `main.tsx:2,20-35`, `lib/sentry.ts`, `vite.config.ts` | **Med-High × S** |

---

## A. The Changes / diff pipeline (GIT-B2 and its amplifiers) — the top cluster

This is the biggest lever and the most-confirmed. Four defects compound in the same code path; at 30–80 changed files with an agent editing, they multiply.

### A1. Every changed file's full diff is fetched over IPC, collapsed or not (GIT-B2, data layer)
- **Problem:** `ChangesPanel` calls `useDiffFiles`, which fires a `useQueries` running `tauri.gitDiff(workspaceId, scope, path)` for **every** entry in `changes`, gated only on `enabled: !!workspaceId` — there is no expansion gate. A 200-file change = 200 IPC round-trips, each a blocking git subprocess. Worse, `git/diff.rs::diff()` runs an *extra* `git status --porcelain -- <path>` per untracked file (diff.rs:37), so it can be up to **2N git process spawns**.
- **Where:** `src/components/ChangesPanel.tsx:569-605` (`useDiffFiles`), `src-tauri/src/git/diff.rs:31-53`.
- **Impact (High):** Opening the Changes panel on a large worktree fans out hundreds of git subprocesses at once; the panel is unusable-slow exactly when the agent has done the most work.
- **Fix:** Fetch a file's raw diff only when its `DiffCard` is expanded (lift expansion state so the query is `enabled: expanded`). Bounds work to O(visible), not O(changed).
- **Impact × Effort: High × M.**

### A2. Collapsed cards still parse the full diff just to draw a badge
- **Problem:** `DiffCard` runs `parseUnifiedDiff(file.raw)` in a `useMemo` for **every** card regardless of `expanded`, because the collapsed header needs `countAddsRemoves` and status. Only the heavy `DiffView`/Shiki body is gated on `expanded`. So parse cost is O(all changed lines) across the worktree on mount.
- **Where:** `src/components/diff/DiffCard.tsx:128-133` (parse + counts), `:309` (only the body is `expanded`-gated).
- **Impact (High):** Main-thread parse of the entire change set on mount and after every refetch.
- **Fix:** Return `+adds/-removes` and per-file status from the backend `status` command via a single `git diff --numstat` + `--name-status` (one git call for the whole worktree). Then collapsed headers need no raw diff at all — kills both A1's fetch and A2's parse for collapsed files.
- **Impact × Effort: High × S** (backend side) **+ M** (wire the frontend). Pairs with A1.

### A3. The whole diff set refetches on every filesystem tick
- **Problem:** `invalidateWorkspaceGit` invalidates `["git","diff",workspaceId]` — *all* per-file diff queries — plus status/branchStatus/mergeInProgress/log. It's called on every `worktree-changed` fs event (debounced ~300 ms server-side) and after every mutation. So while an agent writes files, the entire A1+A2 storm re-fires at ~3 Hz.
- **Where:** `src/lib/hooks/useGit.ts:28-37` (invalidate), `:57-78` (fs-event → invalidate).
- **Impact (High):** Continuous CPU + IPC churn during the core workload; the UI never settles while the agent is active.
- **Fix:** Include the changed path(s) in the `worktree-changed` payload and invalidate only those diff keys; or, with A1 in place, only visible cards hold live queries so the blast radius is already small.
- **Impact × Effort: High × M.**

### A4. `useGitStatus` is mounted 3× per workspace → 3× watchers and 3× invalidation fan-out
- **Problem:** `useGitStatus(workspaceId)` runs at three call sites for the same workspace (the `$workspaceId` route, `WorkspaceRightSidebar`, and `ChangesPanel`). React Query dedupes the *query*, but the `useEffect` that registers the `worktree-changed` listener and calls `watchWorkspace`/`unwatchWorkspace` runs **per instance** — so one workspace has **3 concurrent listeners**, `invalidateWorkspaceGit` fires **3× per fs event**, and there's an unwatch race (one unmount can `unwatchWorkspace` while siblings still need it).
- **Where:** `src/lib/hooks/useGit.ts:43-81`; call sites `routes/_app/repositories/$repositoryId/workspaces/$workspaceId.tsx:39`, `WorkspaceRightSidebar.tsx:18`, `ChangesPanel.tsx:55`.
- **Impact (Med-High):** Triples the A3 storm and risks losing the watcher entirely on a race.
- **Fix:** Move the watch + listen lifecycle into one dedicated hook mounted once per workspace (or ref-count the watcher); keep `useGitStatus` as a pure query.
- **Impact × Effort: Med-High × S.**

### A5. Shiki tokenizes per-line, synchronously, in render, with no memoization
- **Problem:** `HighlightedLine` calls `highlight(source)` in its render body; `tokenizeLine` calls `highlighter.codeToTokensBase` **once per line**. Tokens aren't memoized and `useShiki`'s `highlight` is a fresh closure each render, so any re-render (A3/A4 cause many) re-tokenizes every visible line. Side-by-side roughly doubles it.
- **Where:** `src/components/diff/DiffView.tsx:519-545`, `src/lib/diff/shiki.ts:67-84`, `src/lib/hooks/useShiki.ts:63`.
- **Impact (High):** The main-thread stall when expanding a diff, made continuous by the refetch storm.
- **Fix:** Memoize tokens per `(content, lang, theme)` in a module-level cache; stabilize `highlight` with `useCallback`; ideally tokenize once when `raw` changes rather than in render. Consider a Web Worker for large files. React 19 is available — `useDeferredValue`/`startTransition` can keep highlight off the interaction path.
- **Impact × Effort: High × M.**

### A6. Card identity churn defeats memoization
- **Problem:** `useQueries` returns a new `results` array each render → the `useMemo` at `ChangesPanel.tsx:587` always rebuilds a fresh `DiffCardFile[]` → `DiffList` gets a new `files` reference → `DiffCard` is **not** `React.memo`, so every card re-renders on every panel render (and re-runs A5). Callbacks (`copyPath`, `handleStage/Unstage/Discard`) and `conflictActions` are also recreated each render.
- **Where:** `ChangesPanel.tsx:151-187,569-605`, `diff/DiffCard.tsx` (no memo).
- **Impact (High, as an enabler):** Without stable identity, A5's memoization can't help.
- **Fix:** Memoize each `DiffCardFile` by `(path, raw, staged, unstaged)`, wrap `DiffCard` in `React.memo`, and `useCallback`/`useMemo` the callbacks and `conflictActions`.
- **Impact × Effort: High × M.**

### A8. The fs-watcher is recursive and gitignore-unaware — builds and installs trigger the storm
- **Problem:** `fswatch.rs` watches the entire worktree with `RecursiveMode::Recursive` and filters `.git/` only *after* receiving events, with **no gitignore awareness.** So writes under `node_modules/`, `target/`, `dist/`, and any build/test output all fire `worktree-changed`, which invalidates status + branchStatus + mergeInProgress + **all** diffs + log. An agent that runs `npm install` or a build/test loop generates a continuous stream of events, each triggering the full A1+A3+P-git cascade.
- **Where:** `src-tauri/src/fswatch.rs:54-88` (watch setup + post-hoc `.git/` filter), fan-out via `useGit.ts:28-37`.
- **Impact (High):** This is the most likely "the app gets hot and laggy" reproducer — it fires exactly when the agent is doing tool-heavy work.
- **Fix:** Scope the watch to tracked paths / respect `.gitignore` (or at least hard-exclude `node_modules`, `target`, `dist`, `.git`), and rate-limit/coalesce `worktree-changed` per workspace (min ~500 ms–1 s between emits). On an fs event, invalidate only `status` and derive diffs lazily.
- **Impact × Effort: High × M.**

### A7. No virtualization or hard large-diff ceiling
- **Problem:** `DiffList` renders a card per file with no windowing; `DiffView` caps at 50 hunks per "Show more" batch but a single huge generated file (lockfile) still tokenizes 50 hunks × many lines synchronously. `run_git` returns unbounded stdout, so a giant diff is fully materialized in Rust, serialized as one JSON string over IPC, parsed, and rendered.
- **Where:** `diff/DiffList.tsx:183`, `diff/DiffView.tsx:36,308-338`, `git/error.rs:21-34`.
- **Impact (Med):** Pathological files (lockfiles, generated code, minified bundles) freeze the panel.
- **Fix:** Windowing (`react-window`) for the card list and for large hunk row sets; a byte/line ceiling that falls back to a plain `<pre>` (or "diff too large — open in editor") past a threshold; cap `run_git` stdout.
- **Impact × Effort: Med × S** (ceiling) **/ L** (full virtualization).

---

## B. Cold start / startup

### B1. The Tauri `setup` hook blocks on DB init + migrations + full startup recovery
- **Problem:** `setup` calls `tauri::async_runtime::block_on(initialize_database_state(...))`, which runs migrations, then `recover_startup_state`: it lists all `Running` workspaces and issues **a DB write per workspace** to mark them Stopped, then iterates **every repository** running **`git worktree prune` synchronously** (one git subprocess per repo). All of this blocks the setup path before the app is ready.
- **Where:** `src-tauri/src/lib.rs:108` (`block_on`), `:209,229-278` (`recover_startup_state`), `git::prune_worktrees`.
- **Impact (Med, scaling to High):** Cold-launch latency grows with (# repos) × (git prune time) + (# running workspaces) × (DB write). A user with many repos on a slow disk waits on serial git subprocesses every launch.
- **Fix:** Show the window immediately with a lightweight ready state; move `recover_startup_state` (especially `prune_worktrees`) to a background task after first paint; batch the running→stopped update into one `UPDATE ... WHERE status='running'` instead of a write per row.
- **Impact × Effort: Med × M.**

### B2. Sentry + Supabase parse before first paint
- **Problem:** `main.tsx` statically imports `@clerk/react`, `./lib/sentry` (`import * as Sentry from '@sentry/react'`), `./lib/supabase`, and runs `initSentry(router)` eagerly at module top. With no `manualChunks`, all of it lands in the 227 KB-gz entry chunk that blocks render.
- **Where:** `src/main.tsx:2,20-35`, `src/lib/sentry.ts:1`.
- **Impact (Med):** Sentry + Supabase parse/eval on every cold launch before the UI paints, though neither is needed at first paint.
- **Fix:** `initSentry` behind `await import('@sentry/react')` in an idle callback after first paint; lazy-import the Supabase client on first use; add `manualChunks` to isolate `react`/`clerk`/`sentry`/`supabase`.
- **Impact × Effort: Med-High × S.**

### B3. `useShiki` instantiates the highlighter at module import
- **Problem:** `useShiki.ts:82` runs `void getHighlighter().then(...)` at module load — importing the diff hook chunk triggers highlighter creation (preloaded grammars + WASM) before any diff is on screen, front-loading ~300 KB-gz of Shiki when the workspace route mounts.
- **Where:** `src/lib/hooks/useShiki.ts:82`.
- **Impact (Low-Med):** Moves Shiki cost to route-mount instead of first actual highlight.
- **Fix:** Kick off `getHighlighter()` from an effect/interaction or `requestIdleCallback`; keep the sync cache, populate lazily.
- **Impact × Effort: Low-Med × S.**

---

## C. Bundle / load / Shiki (measured)

`dist/assets/` = **10.6 MB JS across 346 files** + 64 KB CSS. First-paint blocking set ≈ **238 KB gz / 784 KB raw** (entry JS + one CSS). Two "known facts" were corrected by measurement:

- The **723 KB / 227 KB-gz `index-*.js` is the app entry, not Shiki** (Clerk ×116, Sentry ×20, Supabase, react-dom, + 17 route dynamic imports). This is the real cold-start cost. → see **B2**.
- **`emacs-lisp-*.js` (780 KB / 197 KB gz) is a lazy per-language grammar chunk**, only fetched if someone opens an emacs-lisp diff. It is *not* shipped at first paint — but it is one of **336 grammar chunks totalling 9.07 MB** bundled to disk.

### C1. Shiki bundles all 301 languages + a 622 KB Oniguruma WASM blob
- **Problem:** `shiki.ts` imports `createHighlighter` from the full `"shiki"` entry (v4.1.0). That emits the 301-thunk language registry and materializes ~9 MB of grammar chunks in the Tauri bundle, plus a base64-inlined 622 KB / 231 KB-gz Oniguruma WASM chunk that must be `atob`-decoded and `WebAssembly.instantiate`-d on the **first** diff render. Only 5 languages are actually preloaded (`typescript, tsx, javascript, jsx, json`); 290+ grammars are dead weight on disk.
- **Where:** `src/lib/diff/shiki.ts:14-19,23`; measured chunks `wasm-CG6Dc4jp.js`, `useShiki-*.js` (core + registry, 67 KB gz).
- **Impact (Med runtime / High install size):** ~231 KB-gz decode + WASM compile latency and memory on the first diff; ~8 MB of grammars inflate the `.dmg`/`.app` and every auto-update download.
- **Fix:** Migrate to `shiki/core` + `createHighlighterCore` with the **JavaScript regex engine** (`createJavaScriptRegexEngine()`), importing only ~10–15 grammars the app realistically renders (`@shikijs/langs/*`) and the two `github-*` themes (`@shikijs/themes`). The JS engine is sufficient for these and **eliminates the WASM chunk entirely**; the curated set drops ~8 MB. Keep a lazy fallback for exotic languages.
- **Impact × Effort: High × M.** (Pairs with A5/B3.)

### C2. No `build` block in `vite.config.ts`
- **Problem:** The config has plugins/resolve/server only — no `build.target`, `manualChunks`, `chunkSizeWarningLimit`, `sourcemap`, or `minify`. So 500 KB+ chunks throw warnings every build, transpilation targets the conservative default instead of the known WKWebView/WebView2 baseline, vendors aren't isolated, and Sentry reports minified stacks.
- **Where:** `vite.config.ts`.
- **Fix:** Add `build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1000, rollupOptions: { output: { manualChunks: … } } }`.
- **Impact × Effort: Med × S.**

> Route/the previous engine chunking is **already handled** by `TanStackRouterVite({ autoCodeSplitting: true })` — the previous engine sits in the workspace-route chunk, not first paint, and no devtools leak into prod. No action.

---

## D. Terminal & long-session stability

The terminal hot path is well built: the previous engine buffers `term.write` and flushes on rAF, PTY input routes straight to `sendInputToTask` with **no React state per keystroke**, and each PTY runs on a dedicated blocking thread with a 128 KB replay buffer. Two long-session risks remain.

### D1. Unbounded terminal + GPU context accumulation across workspace switches

> **RESOLVED (2026-08).** A bounded LRU now caps live surfaces and eviction
> leaves the PTY running; the engine swap also removed the WebGL context cap
> entirely. See ADR-002.
- **Problem:** All inner tabs render simultaneously (`display:none` to keep PTYs alive), and module-level caches persist terminal instances after React unmount — freed only by explicit close (⌘W / `forgetRepository`). Browsers cap active WebGL contexts (~16); switching across many workspaces accumulates contexts until they're force-lost, and **no `WebglAddon` context-loss handler is registered**, so a terminal goes blank with no recovery.
- **Where:** `WorkspaceTabContent.tsx:76-121`, `Terminal.tsx:65`, `SessionTerminalTab.tsx:72`; missing `webgl.onContextLoss(...)`.
- **Impact (Med-High for power users):** Long sessions with many workspaces silently blank terminals.
- **Fix:** Register `webgl.onContextLoss(() => { webgl.dispose(); /* fall back to canvas */ })`; add an LRU cap that disposes least-recently-used cached terminals beyond a limit.
- **Impact × Effort: Med-High × M.**

### D3. PTY output is one IPC/Channel message per 4 KB read, and lag silently drops chunks
- **Problem:** The PTY pump reads 4096-byte chunks and emits one `PtyEvent::Output` per read, each relayed straight to the Tauri `Channel` — a chatty agent or `cat bigfile` floods small IPC messages with no coalescing. The broadcast channel is bounded at 2048 and `RecvError::Lagged` is treated as `continue` (skipped), so a burst while a consumer is briefly behind leaves **gaps in the terminal** (corrupted the previous engine state); the replay buffer is only 128 KB.
- **Where:** `src-tauri/src/pty/handle.rs:13` (128 KB replay), `:178` (2048 cap), `:323,344-368` (per-4 KB emit); `commands/orchestrator.rs:104-127` (forwarder), `:122` + `orchestrator/service.rs:489` (Lagged → continue).
- **Impact (Med):** IPC overhead under heavy output, and rare but real terminal corruption on lag.
- **Fix:** Coalesce output on a short timer (flush accumulated bytes every ~8–16 ms or at 16–32 KB) — this also smooths the previous engine rendering; on `Lagged`, backfill from the on-disk `<task>.log` (the pump always writes it) or surface an "output truncated" marker.
- **Impact × Effort: Med × S.**

### D2. `refit` is not debounced
- **Problem:** `window "resize"` → `refit` and `ResizeObserver(refit)` both call `fit.fit()` + `term.refresh()` synchronously. With several terminal tabs mounted at once, a window drag runs fit+refresh on every mounted terminal per resize event.
- **Where:** `Terminal.tsx:330-333` (and the sibling in `SessionTerminalTab.tsx`).
- **Impact (Med):** Dropped frames while resizing with multiple terminals open.
- **Fix:** rAF-coalesce / debounce `refit`.
- **Impact × Effort: Med × S.**

---

## E. Backend IPC & git concurrency

### E1. Git shell-outs block the async runtime (no `spawn_blocking`)
- **Problem:** `run_git` uses synchronous `std::process::Command::output()`, and every command handler (`git_status`, `git_diff`, `git_branch_status`, merge/rebase, …) is an `async fn` that calls it directly — **no `spawn_blocking`**. Each blocking git subprocess ties up a Tokio worker thread for its full duration. A GIT-B2 burst (A1) of N concurrent `git_diff` calls can saturate all workers, starving unrelated IPC — including PTY input and cloud sync — until the subprocesses finish.
- **Where:** `src-tauri/src/git/error.rs:21-34`; all handlers in `src-tauri/src/commands/git.rs:68+`.
- **Impact (High under load):** On a large repo, one heavy `git status`/`git diff` (or a diff burst) makes the terminal feel frozen.
- **Fix:** Run git via `tokio::task::spawn_blocking` (or a dedicated blocking pool), so subprocess waits don't consume async workers. Cap captured stdout (see A7).
- **Impact × Effort: High × S-M** (mechanical, localized to `run_git`/handlers).

### E2. `branchStatus` polls git every 60 s per open workspace
- **Problem:** `useGitBranchStatus` sets `refetchInterval: 60_000`, so each open workspace shells out `git` for ahead/behind every minute even when idle. Minor, but it's a git subprocess on a timer.
- **Where:** `src/lib/hooks/useGit.ts:220-227`.
- **Impact (Low):** Steady low-rate subprocess churn.
- **Fix:** The fs-watcher already catches HEAD moves (`.git/HEAD` is inside the watched tree); rely on it and drop or lengthen the interval.
- **Impact × Effort: Low × S.**

### E3. SQLite pool: no `busy_timeout`
- **Problem:** Pool is otherwise well-configured (WAL, `synchronous=NORMAL`, foreign keys, 5 connections, migrations at init), but no `busy_timeout` is set, so a write contending with the sync task can fail fast with `SQLITE_BUSY` instead of waiting briefly.
- **Where:** `src-tauri/src/store/pool.rs:16-26`.
- **Impact (Low):** Rare transient write errors under sync + user-write overlap.
- **Fix:** `.busy_timeout(Duration::from_secs(5))` on `SqliteConnectOptions`.
- **Impact × Effort: Low × S.**

### E4. Cloud sync pulls entire tables every cycle and pushes one HTTP request per dirty row
- **Problem:** The sync loop runs every 30 s (or on a 300 ms-debounced trigger) and pulls **whole tables with no filter/limit each cycle** (`GET /workspaces?select=*`, `/repositories?select=*&order=updated_at.desc`, run_commands). Each pulled row then does a `SELECT updated_at` + `UPDATE`/`INSERT` — per-row DB round-trips. Pushes are one HTTP upsert **per dirty row** plus a `mark_synced` UPDATE per row. Cost grows linearly with cloud data and is re-paid every 30 s even when nothing changed.
- **Where:** `src-tauri/src/sync/mod.rs:21,24,160-165` (cadence), `:460-463,623-624` (full-table pulls), `:634-755` (per-row upsert/push/mark).
- **Impact (Med):** Steady background CPU + network + battery that scales with account size; contends with UI writes for the 5-connection pool.
- **Fix:** Incremental pulls (`updated_at=gt.<watermark>` per table, persist the watermark); batch pushes into one array upsert (PostgREST supports it); batch `mark_synced`.
- **Impact × Effort: Med × M.**

### E5. `read_task_log` ships the entire agent log over IPC as one string
- **Problem:** Opening a finished/reattached workspace reads the whole `<task>.log` via `tokio::fs::read` and returns it as a single `String` — a long-lived agent's log can be megabytes, materialized and serialized in one IPC message. `synthesise_new_file_diff` similarly reads an entire untracked file into memory to build its diff.
- **Where:** `src-tauri/src/orchestrator/service.rs:364-372` (log read), `src-tauri/src/git/diff.rs:65-87` (untracked file read).
- **Impact (Med):** A large-log or large-untracked-file workspace opens with a visible stall and a memory spike.
- **Fix:** Tail the log to the last N KB (match the replay window) or stream it; cap the untracked-file diff size with a "file too large" fallback.
- **Impact × Effort: Med × S.**

### E6. Sidebar issues one `list_workspaces` IPC + DB query per repository
- **Problem:** Each repo block calls `useWorkspaces(repoId)`, so M repos = M IPC calls + M DB queries + M pool acquisitions (pool max = 5) on load.
- **Where:** `src/components/AppSidebar.tsx:266`, `commands/workspaces.rs` (`list_workspaces`).
- **Impact (Low):** Cheap per call but fans out on every app load; can briefly exhaust the pool alongside sync.
- **Fix:** A single `list_workspaces_for_user()` returning all rows, grouped client-side.
- **Impact × Effort: Low × S.**

---

## F. Reliability — restore, sync conflicts, data loss (the trust cluster)

### F1. Workspace restore doesn't self-heal a missing worktree (the "✗ Failed to start" bug)
- **Problem:** On relaunch, `recover_startup_state` marks running workspaces Stopped and runs `git worktree prune` (which removes git's record of a missing worktree) but **never reconciles the DB's `worktree_path`.** When the user later opens that workspace, `cwd_for_task` sees `worktree_path` set, finds the directory gone, and returns `RepositoryPathMissing` → the terminal shows "✗ Failed to start". There is no recreation path. (Diagnostics B1 + Phase A already shipped; this is the deferred B3 fix.)
- **Where:** `src-tauri/src/orchestrator/service.rs:408-427` (`cwd_for_task` returns `RepositoryPathMissing`), `lib.rs:229-278` (`recover_startup_state`); create path exists at `service.rs:165-181` (`git::create_worktree`).
- **Impact (High — direct churn):** A moved repo, a cleaned temp dir, or a machine change makes a workspace permanently unopenable with a scary error.
- **Fix:** In `cwd_for_task`/`open_terminal`, if `worktree_path` is missing, recreate it from the workspace's branch under the repo lock (reuse `git::create_worktree`); if that's impossible, show a calm "not available on this machine — recreate?" state instead of a hard error.
- **Impact × Effort: High × M.**

### F2. Cloud sync copies `worktree_path` verbatim across machines
- **Problem:** `upsert_workspace_from_cloud` writes the remote `worktree_path` directly into the local row. Repositories already avoid this by machine-scoping `local_path` via `machine_id`, but workspaces don't — so a workspace synced to a second machine points at a path that doesn't exist there, guaranteeing F1 on that machine. (Deferred B2.)
- **Where:** `src-tauri/src/sync/mod.rs:353` (`worktree_path` field synced).
- **Impact (High for multi-machine users):** Cloud sync actively creates broken workspaces on the second device.
- **Fix:** Don't sync `worktree_path` as-is — store NULL and derive `git::default_worktree_base_path().join(id)` locally, or machine-scope it like `local_path`.
- **Impact × Effort: High × S-M.**

### F3. Sync conflict resolution is last-write-wins on `updated_at`
- **Problem:** `pull` keeps the local row only if `current.updated_at >= row.updated_at`, otherwise it overwrites local with remote. This is last-write-wins keyed on wall-clock `updated_at`, so concurrent edits on two machines silently drop the older-timestamped one, and clock skew can pick the wrong winner. Uploads use Supabase `resolution=merge-duplicates` (row-level upsert, not field-level merge).
- **Where:** `src-tauri/src/sync/mod.rs:247-253` (upsert), `:515-521` (LWW pull).
- **Impact (Med — data-loss surface):** Mostly affects workspace metadata (names, statuses) rather than code (code lives in git), so blast radius is bounded — but a renamed/re-configured workspace can silently revert.
- **Fix:** Accept LWW as the model but make it defensible: sync from a monotonic/logical clock or server timestamp rather than local wall-clock; log overwrites; consider field-level merge for user-editable fields.
- **Impact × Effort: Med × M.**

### F4. Orphaned worktree directories are never garbage-collected
- **Problem:** Startup prunes *git's* worktree metadata but doesn't remove orphaned worktree **directories** (~60 observed under `~/.phasr/worktrees` on a healthy machine). They accumulate disk and slow any full-tree scan.
- **Where:** `recover_startup_state` (`lib.rs:229-278`) prunes git only; no dir GC.
- **Impact (Low-Med):** Disk bloat; a growing worktrees dir.
- **Fix:** After `prune_worktrees`, remove worktree dirs with no matching workspace row (in a background task, guarded to only touch `~/.phasr/worktrees`).
- **Impact × Effort: Low-Med × S.**

### F5. `.expect()` in the sync request path can silently kill background sync
- **Problem:** The per-request header builder does `HeaderValue::from_str(anon_key/jwt).expect(...)` on **every** sync HTTP request. A malformed token (e.g. a bad refresh injecting a control character) panics the spawned sync task, which then silently stops syncing until the app restarts — with no user signal. Probability is low (JWTs are ASCII) but it's a latent panic in a hot path in an otherwise unwrap-clean backend. More broadly, non-test `.unwrap()/.expect()` live in `sync/`, `store/`, and `orchestrator/`; command handlers are clean (0 in `commands/`) and most `git/` unwraps (202) are `#[cfg(test)]`.
- **Where:** `src-tauri/src/sync/mod.rs:289,293`; audit non-test occurrences in `store/*`, `orchestrator/*`.
- **Impact (Med):** Sync (the retention-critical "my work followed me to my other machine" feature) dies silently after one bad input.
- **Fix:** Return `SyncError` instead of `expect`; ensure the sync loop catches, logs, and retries rather than aborting the task.
- **Impact × Effort: Med × M.**

### F6. The per-repo write lock guards only one of several `.git`-mutating paths (corruption surface)
- **Problem:** `RepoLockRegistry` exists specifically to serialize writes to a repo's shared `.git`, but it's taken **only** around `create_worktree` inside `start_task`. `create_workspace` runs `create_worktree` with **no lock**, and `git_merge_to_main` checks out branches directly in the **main** repo unlocked. All of these touch the same `.git/index`, `.git/refs`, and `.git/worktrees`. Concurrent create + start, or a merge racing a worktree-add, on one repo can corrupt `index.lock`/refs — exactly the failure the lock was built to prevent.
- **Where:** `src-tauri/src/orchestrator/repo_locks.rs` (registry), `orchestrator/service.rs:174-178` (only lock site), `commands/workspaces.rs:132` (unlocked worktree add), `commands/git.rs:284-313` (unlocked merge checkout).
- **Impact (High if hit):** A corrupted `.git` is a trust-ending, hard-to-diagnose failure — and it happens precisely when the user is doing several things at once in a repo.
- **Fix:** Route every shared-`.git` mutation (create_workspace worktree-add, merge_to_main, branch-delete/remove-worktree on delete) through `repo_locks.for_repository(repo_id)`.
- **Impact × Effort: High × M.**

### F7. Worktree ↔ DB rows can orphan in both directions
- **Problem:** `create_workspace` creates the worktree **then** inserts the row — a crash between them leaves a worktree + `phasr/*` branch on disk with no DB record. `delete_workspace` removes the worktree best-effort (`let _ = git::remove_worktree(...)`) then tombstones the row — if removal fails, the row disappears from the UI but the worktree + branch linger. Both leak disk over time and feed the ~60-orphan pile (F4).
- **Where:** `src-tauri/src/commands/workspaces.rs:132-143` (create order), `:367-376` (delete swallows removal failure).
- **Impact (Med):** Slow disk leak and drift between what the UI shows and what's on disk.
- **Fix:** Insert-then-worktree (or clean up the worktree if the insert fails); on delete, retry/surface removal failures; add periodic reconciliation (`git worktree list` vs live rows).
- **Impact × Effort: Med × M.**

### F8. Workspace status updates are non-atomic read-modify-write (lost-update / status races)
- **Problem:** `WorkspaceRepo::update` does a `get()` then a full-row `UPDATE` with no transaction, with the legal-transition check sitting between the read and the write. The PTY exit watcher, `stop_task`, `open_terminal`, and the `update_workspace` command can all write the same row concurrently — a classic TOCTOU where one write clobbers another (e.g. an exit→Completed racing a stop→Stopped), leaving the workspace in a wrong terminal state.
- **Where:** `src-tauri/src/store/workspaces.rs:203-276` (read-modify-write), writers at `orchestrator/service.rs:455-486`, `:256-266`, `:323-335`.
- **Impact (Med):** A workspace shows the wrong status after a race — confusing, and can gate actions (push/merge) incorrectly.
- **Fix:** Single conditional `UPDATE ... WHERE id=? [AND status=?]` (gate the transition in SQL), or wrap read+write in a `BEGIN IMMEDIATE` transaction.
- **Impact × Effort: Med × M.**

---

## Consolidated ranked backlog

| Rank | Finding | Section | Impact × Effort |
|------|---------|---------|-----------------|
| 1 | Backend `numstat` for badges → collapsed cards need no diff (kills A1 fetch + A2 parse) | A1/A2 | High × S-M |
| 2 | Git shell-outs → `spawn_blocking` + stdout cap | E1/A7 | High × S-M |
| 3 | Scope fs-watcher (gitignore) + coalesce `worktree-changed` | A8 | High × M |
| 4 | Narrow diff invalidation to changed path | A3 | High × M |
| 5 | One fs-watcher/listener per workspace (not 3×) | A4 | Med-High × S |
| 6 | Shiki → JS engine + `shiki/core` curated langs | C1 | High × M |
| 7 | Restore self-heals missing worktree (B3) | F1 | High × M |
| 8 | Route all `.git` mutations through the repo lock (corruption) | F6 | High × M |
| 9 | Stop syncing `worktree_path` verbatim (B2) | F2 | High × S-M |
| 10 | Memoize Shiki tokens + `React.memo(DiffCard)` + stable identity | A5/A6 | High × M |
| 11 | Fetch raw diff only on card expand | A1 | High × M |
| 12 | Defer Sentry/Supabase off first paint | B2 | Med-High × S |
| 13 | Vite `build` block (target/manualChunks/sourcemap) | C2 | Med × S |
| 14 | Move startup recovery/prune off the setup block_on | B1 | Med × M |
| 15 | Incremental sync pulls + batched pushes | E4 | Med × M |
| 16 | Non-atomic status update → conditional SQL / txn | F8 | Med × M |
| 17 | WebGL context-loss handler + LRU terminal cap | D1 | Med-High × M |
| 18 | Coalesce PTY output + backfill on lag | D3 | Med × S |
| 19 | Tail `read_task_log` instead of full slurp | E5 | Med × S |
| 20 | Worktree↔DB orphan reconciliation | F7 | Med × M |
| 21 | Debounce terminal `refit` | D2 | Med × S |
| 22 | GC orphaned worktree dirs | F4 | Low-Med × S |
| 23 | Fix sync `.expect()` + audit background unwraps | F5 | Med × M |
| 24 | Large-diff virtualization + hard ceiling | A7 | Med × S–L |
| 25 | Single `list_workspaces_for_user` (sidebar N+1) | E6 | Low × S |
| 26 | Drop/lengthen 60 s branchStatus poll | E2 | Low × S |
| 27 | SQLite `busy_timeout` | E3 | Low × S |
| 28 | Lazy highlighter init (drop module-scope side effect) | B3 | Low-Med × S |

---

## Profile-this-first (measure before committing effort)

Confirm the hotspots with real numbers before/after each change:

1. **React Profiler flamegraph while an agent edits ~30–80 files, Changes panel open.** Expect repeated full `ChangesPanel` commits, every `DiffCard` re-rendering, and long `codeToTokensBase` self-time. Confirms A1–A6 together.
2. **IPC call counter on `tauri.gitDiff`** during a `worktree-changed` event. Expect N calls × 3 (the ×3 fan-out). Confirms A1/A3/A4. Add a temporary `eprintln!`/counter in `git_diff`.
3. **Backend subprocess timing:** log wall-time per `run_git` and the count of concurrent in-flight git processes during a Changes-panel mount on a large repo. Confirms A1 + E1 (worker starvation).
4. **Performance panel — "expand a large file" (lockfile, side-by-side).** Look for a long synchronous scripting block dominated by `codeToTokensBase`. Confirms A5/A7.
5. **Cold-start trace:** mark webview navigationStart → first `RouterProvider` paint; separately time the first diff's WASM `instantiate` + first `codeToTokens`. Sizes B1/B2/C1. Add `rollup-plugin-visualizer` (gzip+brotli) to see the entry's Clerk/Sentry/Supabase/React byte split, and use the DevTools Coverage tab to measure unused % of the 227 KB-gz entry at first paint.
6. **`chrome://gpu` + repeated workspace switching** (open 20+ workspaces' terminals): watch active WebGL context count climb and for "context lost" / blank terminals. Confirms D1.
7. **Relaunch matrix:** with a workspace open, (a) move its worktree dir, (b) delete it, (c) sync to a second machine — relaunch and confirm the `RepositoryPathMissing` path each time. Confirms F1/F2 and validates the self-heal fix.
8. **`du -sh` on the built `.app`/`.dmg` before/after the Shiki-core migration** to quantify the ~8–9 MB install-size drop; re-run the `dist/assets` size + grammar-chunk count (301 → ~12) after.
9. **fs-watcher amplification (the top "app gets hot" reproducer):** count `worktree-changed` emits/sec and the downstream git-subprocess spawns while an agent runs `npm install` or a build/test loop in a watched worktree. Confirms A8 (and its interaction with A3/E1). A `run_git` wrapper that logs `args[0]` + elapsed + a global spawn counter turns this into a spawns/sec gauge and a histogram by subcommand.
10. **Worker-thread starvation canary:** run a trivial async task that records its own scheduling delay, then open a 50-file diff — a spike in delay proves E1's head-of-line blocking is real (or enable tokio runtime metrics).
11. **Sync-cycle telemetry:** per `sync_once`, log wall-time, rows pulled/pushed per table, HTTP request count, and bytes. Confirms E4's full-table pulls and their growth with account size; also measures pool-acquire wait time (max 5 connections) during a busy sync + UI load.

---

## What's already good (don't touch)

- **fs-watcher instead of status polling** — the *mechanism* is right (debounced 300 ms, per-workspace, stopped on navigate-away). It just needs scoping + coalescing (A8) and single-mounting (A4) to stop amplifying the diff storm; keep the fs-watcher approach, fix its blast radius.
- **Route-level code splitting** via TanStack Router `autoCodeSplitting` — works; the previous engine and heavy routes are off first paint. No action.
- **Terminal hot path** — the previous engine rAF-batched writes, PTY input with no per-keystroke React state, dedicated blocking thread per PTY, listeners/observers cleaned up on unmount. (Caveats: the WebGL context accumulation in D1 and the output-coalescing/lag-drop in D3 are the two things to fix; the write path itself is fine.)
- **Zustand discipline** — one store but consumers use field selectors returning primitives/stable slices; not a re-render source.
- **React Query config** — `staleTime: 30s`, `refetchOnWindowFocus: false`, immutable data cached `Infinity`, stable structured query keys.
- **SQLite** — WAL, `synchronous=NORMAL`, foreign keys, pooled, migrations at init (add `busy_timeout`, E3).
- **Sync** — background task (30 s interval + 300 ms debounce), 15 s HTTP timeout, soft-delete propagation. (Make pulls incremental and pushes batched, E4; harden the panic path, F5.)
</content>
</invoke>
