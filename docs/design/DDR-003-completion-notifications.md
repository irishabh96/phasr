# DDR-003: Agent-Completion Notifications — OS notification + in-app toast

**Status:** Ready for fe-developer (Wave 2) · **Date:** 2026-07-12 · **Mode:** DESIGN
**Builds on:** DDR-002 (toast system, `glass-panel`, intent icons, persist rules).
**Scope:** Completion-first — `completed` and `failed` PTY-exit events only.
**Out of scope:** "needs input" / turn-completion signals (no such event exists; see caveat).

---

## Brief

- **User** — a developer running one or more agents across git workspaces in phasr
  (Tauri desktop, keyboard-first), who steps away or switches apps while an agent runs.
- **Job-to-be-done** — *find out the moment an agent finishes* (or dies) without
  babysitting the window, and get back to the right workspace in one click.
- **Success criteria**
  1. When the app is **unfocused/hidden**, a completed/failed agent produces an **OS
     notification**; clicking it raises phasr and lands on that workspace.
  2. When the app is **focused**, the same event produces an **in-app toast** (not an
     OS notification) with a one-click "Review changes" action — unless you're already
     looking at that workspace (then: silence; the in-pane `TerminalStatus` shows it).
  3. Failures are never missed; multiple near-simultaneous finishes don't spam.
  4. Zero new AA regressions — in-app surface reuses DDR-002's verified glass tokens.
- **Constraints** — Tauri + React; reuse `showToast` (`src/lib/toast.ts`), the
  `AppToaster` (DDR-002), and the existing `phasr://task-status` listener
  (`src/lib/hooks/useTaskEvents.ts`). Flat/glass direction. Light + dark parity.

> **Signal caveat (must read).** `phasr://task-status` `completed`/`failed` fires on
> **real PTY process death** only. Per the note in `useTaskEvents.ts`, interactive
> REPL agents (Claude / Codex / Cursor) *don't* exit between turns — so this notifies
> on a **one-shot agent finishing**, a **crash**, `exit`, or a **stop**, **not** on
> "the agent finished a turn." Copy is written to be true for all of those.
> `stopped` is treated as neither success nor failure → **no notification** (the user
> initiated it). `archived`/`pending`/`running` → no notification.

---

## Existing System (Discovery)

**Reused as-is:**

| Need | Token / component / API | Note |
|---|---|---|
| In-app surface | `AppToaster` + `showToast()` (DDR-002) | glass card, intent icon, persist rules |
| Intent colors | `--color-success` / `--color-danger` | `CircleCheck` / `CircleAlert`, computed below |
| Text | `--color-text-primary` / `-secondary` / `-muted` | AA-verified below |
| Event source | `phasr://task-status` via `useTaskEvents.ts` | already mounted app-wide; add notification side-effect here |
| Currently-viewed workspace | `store.activeWorkspaceContext.{workspaceId,repositoryId}` | drives the "don't notify what I'm looking at" dedupe |
| Names | React-Query cache: `["workspaces","detail",taskId]` + repository query | resolve `workspace.name` / `repository.name` at fire time |
| Window focus/nav | `@tauri-apps/api/window` (`getCurrentWindow().setFocus/unminimize`) + TanStack Router | already deps |

**Gaps that need net-new work (justified):**

1. **OS notification transport** — `@tauri-apps/plugin-notification` (JS) and
   `tauri-plugin-notification` (Rust) are **not installed** (checked `package.json` /
   `Cargo.toml`). Net-new dependency + capability grant. **→ escalate to tauri-engineer.**
2. **Internal toast action** — today `ToastAction = { label, url }` and `AppToaster`
   only `openUrl()`s it. "Review changes" needs **in-app navigation**, not a browser
   open. Small union extension to `toast.ts` + `AppToaster.tsx` (spec'd below).
3. **Notification click → activation** — clicking an OS notification must focus the
   window and route to the workspace. Recommend a Rust-emitted
   `phasr://notification-activated { taskId, repositoryId }` the frontend listens to
   (mirrors the existing `phasr://` pattern). `#PLAN_UNCERTAINTY` on the plugin's exact
   click-callback API — tauri-engineer to confirm.

No new color / radius / motion tokens are required.

---

## Directions

### Direction A — "Focus-routed dual channel" *(recommend)*
- **Idea**: one place (a `useCompletionNotifications` side-effect on the existing
  task-status stream) decides per event: **OS notification iff app unfocused**,
  **in-app toast otherwise** (and *also* queue the toast when unfocused, so returning
  to the app shows an actionable review queue). Suppress entirely for the
  currently-viewed workspace. Coalesce near-simultaneous finishes.
- **Best when**: exactly this — a desktop tool where the user context-switches.
- **Tradeoffs**: + single decision point, + no double-buzz (never OS *and* toast
  *popping* at once while focused), + the toast survives as the in-app record; − needs
  reliable focus detection (solved below with Tauri `onFocusChanged` + visibility).

### Direction B — "OS-only, no in-app"
- **Idea**: always fire an OS notification, skip toasts.
- **Tradeoffs**: − macOS coalesces/hides banners when the app *is* focused, so
  in-focus finishes get no feedback; − dead-ends users who denied OS permission.
  Rejected: fails success criterion 2.

### Direction C — "Toast-only, no OS"
- **Idea**: only ever show in-app toasts.
- **Tradeoffs**: − invisible when the app is hidden/minimized — the whole point.
  Rejected: fails criterion 1.

**→ Recommendation: Direction A.** It's the only option that covers both the
away-from-app and heads-down cases without double-notifying, degrades cleanly when OS
permission is denied (toast still works), and keeps one testable decision function.
`#PATH_DECISION`

---

## Spec (Direction A)

### 1. Fire rule (the decision function)

For each `phasr://task-status` event where `status ∈ {completed, failed}`:

```
appFocused   = tauriWindowFocused && document.visibilityState === "visible"
viewingThis  = appFocused && store.activeWorkspaceContext?.workspaceId === taskId

if (viewingThis)            → suppress BOTH   // you're looking at it; TerminalStatus shows the exit
else:
    enqueue in-app toast    // ALWAYS (visible now if focused; waiting for you if not)
    if (!appFocused)  → enqueue OS notification   // only when away/hidden — "do-not-disturb while focused"
```

- **`tauriWindowFocused`** is tracked from `getCurrentWindow().onFocusChanged(...)`
  (authoritative on desktop; minimize/other-app-focus fire it). `document`
  `visibilitychange` is the fallback for OS-level hide. Keep one boolean ref, updated
  by both listeners; default `true` on mount.
- **OS notifications never fire while focused** — this is the entire "do-not-disturb"
  rule. Toasts are the in-focus channel.

### 2. Coalescing & frequency cap

One shared buffer flushes on a trailing timer:

- `COALESCE_WINDOW_MS = 2500`. First qualifying event opens the window; events within
  it accumulate; on flush, decide single vs. grouped. This merges *parallel* finishes
  (agents ending within ~2.5s) while leaving *spread-out* ones as separate cards.
- Flush → **1 event**: single toast + (if unfocused) single OS notification.
- Flush → **≥2 events**: **one** coalesced toast + (if unfocused) **one** coalesced OS
  notification. This *is* the frequency cap for OS notifications (≤1 per flush).
- In-app pileup is bounded by `MAX_TOASTS = 4` (existing) + coalescing.
- If a `taskId` appears twice in one window (shouldn't, but e.g. status re-emit),
  keep the **last** status for that id (dedupe by id inside the buffer).

### 3. Copy (workspace name + repo name)

Resolve `w = workspace.name`, `r = repository.name` from cache at fire time. Fallbacks:
if name is missing, use `"This workspace"` / `"the repository"` (never render `undefined`).

**Completed (single)**

| Channel | String |
|---|---|
| OS title | `{w} finished` |
| OS body | `Agent completed in {r}. Click to review changes.` |
| Toast title | `{w} finished` |
| Toast message | `Agent completed in {r}. Review the changes.` |
| Toast action | `Review changes` |

**Failed (single)**

| Channel | String |
|---|---|
| OS title | `{w} failed` |
| OS body | `The agent exited unexpectedly in {r}. Click to view.` |
| Toast title | `{w} failed` |
| Toast message | `The agent exited with an error in {r}.` |
| Toast `code` (mono) | `exit code {N}` — only when `exitCode != null && exitCode !== 0` |
| Toast action | `View workspace` |

**Coalesced (≥2 in the window)** — `A` = completed count, `F` = failed count, `N = A+F`:

| Channel | String |
|---|---|
| OS/Toast title | `{N} agents finished` |
| Body/message (all completed) | `Completed in {r1}, {r2}{, +K more}. Review them from the sidebar.` |
| Body/message (mixed / any failed) | `{A} completed, {F} failed. Review them from the sidebar.` |
| Toast action | `Review latest` → the most-recent workspace in the batch |

Copy rules: no jargon, no stack traces, no trailing exclamation, name the *place*
(repo) so it's glanceable across many workspaces. Repo list truncates after 2 names
with `+K more`.

### 4. Toast treatment

| Property | Completed | Failed |
|---|---|---|
| `intent` | `success` | `error` |
| Icon (from DDR-002 map) | `CircleCheck` `--color-success` | `CircleAlert` `--color-danger` |
| `role` / live | `status` / polite | `alert` / assertive |
| Auto-dismiss | **No — persists** (has an action → DDR-002 rule) | **No — persists** (error → DDR-002 rule) |
| Action | `Review changes` | `View workspace` |
| `code` field | — | `exit code {N}` when non-zero |

- **Why both persist:** an agent finishing is an *actionable* event (go review the
  diff), not a transient "saved" confirmation — it should wait for the user, and the
  action must never vanish mid-reach (DDR-002 K2). Pileup is bounded by coalescing +
  `MAX_TOASTS=4`. **No change to `toast.ts` timing logic** — this falls out of the
  existing "error or action ⇒ persistent" rule. `#PATH_DECISION`
  *(Alternative considered: auto-dismiss completed toasts after ~12s via a new
  `persistent?: boolean` override. Rejected for now to keep timing logic untouched and
  because the diff is worth acting on. Flagged as an option if telemetry shows fatigue.)*
- **Coalesced toast**: `intent = "error"` if `F > 0`, else `success`; action
  `Review latest`.

### 5. Internal toast action (net-new, small)

Extend the action type so an action can navigate in-app instead of opening a URL:

```ts
// src/lib/toast.ts
export type ToastAction =
  | { label: string; url: string }          // existing — opens in browser (openUrl)
  | { label: string; onClick: () => void }; // NEW — in-app handler
```

```tsx
// AppToaster.tsx — action onClick branch
onClick={() => {
  if ("url" in toast.action!) void openUrl(toast.action!.url);
  else toast.action!.onClick();
  dismissToast(toast.id);
}}
```

No visual change — still `GlassButton variant="outline" size="sm"` (h-8 = 32px).

### 6. Activation (click behavior — both channels do the same thing)

`activateWorkspace(repositoryId, taskId, { revealChanges })`:

1. `getCurrentWindow()` → `.unminimize()` then `.setFocus()` (raise phasr).
2. Router → navigate to
   `/repositories/{repositoryId}/workspaces/{taskId}`.
3. If `revealChanges` (completed): ensure the right panel is open and on the Changes
   tab — `store.setRightPanelCollapsed(false)` + `store.setRightPanelTab(taskId,
   "changes")`. For **failed** (`View workspace`): navigate only; the terminal's
   `TerminalStatus` overlay (DDR-002) already surfaces the failure — don't force the
   Changes panel.

- **Toast action** → calls `activateWorkspace(...)` directly (via the new `onClick`).
- **OS notification click** → Rust emits `phasr://notification-activated { taskId,
  repositoryId, status }`; a small frontend listener calls the *same*
  `activateWorkspace(...)`. Single code path, single source of truth.
  `#PLAN_UNCERTAINTY`: confirm the notification plugin's click hook vs. this
  Rust-emit-event approach — tauri-engineer owns the transport.

### 7. Permissions (first-run UX)

- **Never on cold start.** Requesting before the user has any running agent is
  pre-value and gets denied out of reflex.
- **Ask right after the first successful agent launch** in the app's lifetime:
  on the first `start_task` success, if `!localStorage["phasr.notif.asked"]`:
  1. `isPermissionGranted()` — if already granted/denied, set the flag, do nothing.
  2. else `requestPermission()`; persist `phasr.notif.asked = "1"` regardless of outcome.
- **Denied → graceful degrade.** OS notifications simply never fire; the **in-app
  toast path is unaffected** and remains fully functional. **Never auto re-prompt**
  (respect the OS choice). *(Future, out of scope: a toggle + "open System Settings"
  hint in `settings/appearance` or a notifications settings pane.)*
- Guard every `sendNotification` with a cached `granted` boolean so a denied user
  costs zero plugin round-trips.

### 8. State / event matrix

| Case | App state | Currently viewing target? | OS notif | In-app toast |
|---|---|---|---|---|
| Completed, away | unfocused/hidden | — | ✅ `{w} finished` | ✅ queued (persist) |
| Completed, focused elsewhere | focused | no | ❌ | ✅ (persist) |
| Completed, watching it | focused | **yes** | ❌ | ❌ (TerminalStatus shows it) |
| Failed, away | unfocused | — | ✅ `{w} failed` | ✅ error (persist) |
| Failed, focused elsewhere | focused | no | ❌ | ✅ error (persist) |
| ≥2 within 2.5s, away | unfocused | (any non-viewed) | ✅ 1 coalesced | ✅ 1 coalesced |
| `stopped` / user-initiated | any | — | ❌ | ❌ |
| Permission denied | any | non-viewed | ❌ (degrade) | ✅ still works |
| App quit when agent dies | n/a (no event) | — | ❌ | ❌ → status persists in DB, shown on next launch via sidebar `StatusDot`; **no replay notification** (stale/noisy). *Optional:* one summary toast on launch if `finishedAt > lastSeenAt` — `#PLAN_UNCERTAINTY`, defer. |
| Long workspace/repo name | any | — | OS truncates natively | toast title/message wrap (glass card grows, DDR-002) |
| Reduced motion | any | — | OS-rendered (n/a) | toast enter/exit opacity-only (DDR-002 already) |

No new motion is introduced; the toast reuses DDR-002's `toast-in`/`toast-out` +
reduced-motion rule verbatim. OS notifications are OS-rendered (no phasr motion).

---

## Accessibility

**Contrast — computed** with `.claude/skills/design-system/scripts/check-contrast.mjs`,
on the DDR-002 glass composite (dark `#181e26`, light `#fbfcfc`). These are the only
surfaces this DDR paints; OS notifications are OS-rendered and out of our contrast
scope. No *new* text/bg pair is introduced — verification confirms no regression:

| Element | Token | Dark | Light | Bar |
|---|---|---|---|---|
| Title | `--color-text-primary` | **14.19:1** ✓ | **19.25:1** ✓ | body 4.5 |
| Message | `--color-text-secondary` | **8.53:1** ✓ | **7.52:1** ✓ | body 4.5 |
| `exit code N` (mono) | `--color-text-muted` | **5.45:1** ✓ | **5.92:1** ✓ | body 4.5 |
| success icon | `--color-success` | **6.6:1** ✓ | **3.21:1** ✓ | UI/icon 3.0 |
| danger icon | `--color-danger` | **6.65:1** ✓ | **4.7:1** ✓ | UI/icon 3.0 |

Light success icon = 3.21:1 clears the **3:1 icon/UI** bar (it's a decorative glyph
paired with a text label, never the sole carrier of meaning — intent is icon **+**
color **+** copy).

**Keyboard & SR**
- Toast action (`Review changes` / `View workspace`) and dismiss are Tab-reachable,
  ≥32px, focus-visible accent ring (`--ring-focus`), `Enter`/`Space` fires — inherited
  from DDR-002 `AppToaster`. Toasts don't steal focus on show.
- `role=status`/polite (completed), `role=alert`/assertive (failed) — SR announces the
  finish; the persistent viewport (DDR-002) guarantees the announcement lands.
- OS-notification click activation focuses the window; after routing, initial focus
  should land in the workspace's main region (existing route behavior).

---

## Open Questions / #PLAN_UNCERTAINTY

1. **Notification click transport** — does `@tauri-apps/plugin-notification` give a JS
   click callback, or do we emit `phasr://notification-activated` from Rust? (Recommend
   the Rust event for a single activation path.) tauri-engineer to confirm.
2. **On-launch replay** — surface "N finished while you were away" as one summary toast
   when `finishedAt > lastSeenAt`? Recommend **defer** (sidebar `StatusDot` already
   carries state); needs a `lastSeenAt` persist point.
3. **Auto-dismiss completed toasts** — keep persistent (recommended) or add a
   `persistent?: boolean` override to auto-dismiss successes after ~12s? Revisit if the
   review-queue feels heavy in practice.
4. **Do we notify for `local` (non-agent) workspaces** whose command exits? Recommend
   **completed/failed only for `workspaceKind === "agent"`** — a local shell exiting is
   not an "agent finished." Confirm with POPM.

---

## Handoff (for fe-developer, Wave 2)

**Reuse:** `showToast()`, `AppToaster` (DDR-002 glass card + persist rules),
`useTaskEvents.ts` stream, `store.activeWorkspaceContext`, `setRightPanelCollapsed` /
`setRightPanelTab`, React-Query caches for names, `@tauri-apps/api/window`. All tokens
above. **No new color/radius/motion tokens.**

**Net-new to build:**
1. `toast.ts` — extend `ToastAction` to the `url | onClick` union (§5). No timing change.
2. `AppToaster.tsx` — branch the action `onClick` on `"url" in action` (§5).
3. `src/lib/hooks/useCompletionNotifications.ts` *(new)* — subscribe to
   `phasr://task-status`; implement the fire rule (§1), coalescing (§2), copy (§3),
   `showToast` calls (§4), and `activateWorkspace` (§6). Mount once in the app shell
   alongside `useTaskEvents`. Track `tauriWindowFocused` via `onFocusChanged` +
   `visibilitychange`.
4. Permission bootstrap (§7) — hook into first `start_task` success; localStorage flag.
5. Notification-activated listener (§6) — one `listen("phasr://notification-activated")`
   → `activateWorkspace(...)`.

**Escalate to tauri-engineer (Rust):**
- Add `tauri-plugin-notification` (Rust) + `@tauri-apps/plugin-notification` (JS);
  register the plugin; grant `notification:default` in the capabilities file.
- Wire notification click → emit `phasr://notification-activated { taskId,
  repositoryId, status }` (or expose the plugin's JS click hook if available).
- Confirm PTY-exit → `phasr://task-status` already carries what §3 needs (it does:
  `taskId`, `repositoryId`, `status`, `exitCode`).

**Escalate to POPM:** open question 4 (agent-only vs. also local workspaces).

---

## Amendment (2026-07-13) — leading-edge coalescing (defect D3)

§2's pure trailing coalesce delayed **every** toast by the full `COALESCE_WINDOW_MS`
(2.5s), including a lone finish — the common case. Amended to **leading-edge +
trailing coalesce**: the first completion (when no window is open) shows
**immediately**, then a cooldown window opens; further finishes within it buffer
and flush together at close. So a lone finish appears instantly; a burst = one
instant toast + one coalesced "N agents finished" trailing toast for the
stragglers. Suppression (don't notify the viewed workspace), the OS-vs-toast
rule, dedupe-by-taskId, and `MAX_TOASTS` are unchanged.
Impl: `src/lib/hooks/useCompletionNotifications.ts`. Pinned by
`e2e/forms.spec.ts` "LEADING-EDGE (D3)".
