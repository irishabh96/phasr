# How to Improve Product Experience & Retention for phasr

**Lens:** Product design (activation · habit · trust · perceived performance · delight).
**Date:** 2026-07-12 · **Method:** Grounded in the real flows — read the onboarding,
core-loop, ship-it, and re-entry surfaces plus the store/types. Builds **on** the
craft audit (`docs/design/DESIGN-AUDIT-2026-07-12.md`, Batches 0–4 shipped); does
**not** re-audit contrast/focus/state craft.
**Out of scope (parallel eng report):** raw runtime perf, bundle size, Rust internals.

---

## Executive Summary

phasr's craft floor is now high — the recent audit batches gave it AA tokens, focus
rings, honest empty/loading/error states (`PanelState`), a real toast system, a shared
`TerminalStatus` overlay, and humanized errors. The *screens* are good. **What's missing
is the connective tissue that turns a good tool into a daily habit.**

The core value loop is: **launch → sign in → repo → agent workspace → agent produces a
diff → review → commit → merge/PR.** phasr executes each step competently in isolation,
but the retention-critical *between-the-steps* experience has four structural gaps:

1. **The agent runs in a vacuum.** There is **no signal — none — when an agent finishes
   or pauses for input.** No OS notification (`sendNotification` is used nowhere in
   `src/`), and the status model (`WorkspaceStatus` in `src/lib/types.ts:4`) has no
   "needs input / needs review" state — a paused agent is visually identical to a running
   one (`StatusDot.tsx`). For a tool whose whole premise is "kick off agents and let them
   work," this is the single biggest habit leak. The user must babysit the window.

2. **Re-entry doesn't restore where you were.** The Home route navigates to
   `workspaces?.[0]` — the *newest* workspace of the *most-recent* repo
   (`src/routes/_app/index.tsx:33`) — **not** the workspace you last had open. The
   `phasr.lastWorkspace` restore that memory records as "B1 shipped" is **not present in
   the current code.** Combined with the known "forgets open workspace / ✗ Failed to
   start" relaunch bug (worktree self-heal deferred), the first 5 seconds of every
   returning session risk landing the user somewhere they didn't choose, or on a broken
   terminal. Re-entry is where habit is won or lost, and it's the weakest surface.

3. **No home base across repos.** A dev running 5 agents across 3 repos has no "what
   needs my attention" view. The sidebar shows per-repo status dots but no aggregate; Home
   force-bounces you into a single workspace. There is nowhere to stand and survey the work.

4. **The "aha" is unguided and the payoff is buried.** Time-to-first-diff is gated behind
   OAuth (a hard gate before *any* value), a 2-step form, and a blocking `startTask`
   round-trip with no optimistic UI. Nothing points the new user at the Changes panel
   where the magic appears. And the reward — **Merge / Open PR — is hidden inside the ⋯
   overflow menu** (`WorkspaceActionsMenu.tsx`), so completing the loop feels like a chore
   rather than a win.

Fixing #1 and #2 is where the retention leverage concentrates. Notifications + a real
"needs you" status turn phasr from a window you watch into a tool that pulls you back;
reliable re-entry makes it trustworthy enough to return to.

---

## Scoring

Ranked by **Impact × Effort**. Impact = how much it moves activation/habit/trust/
perceived-perf. Effort is design+frontend unless flagged `+backend`. Lens tags:
`ACT` activation · `HAB` habit/re-engagement · `TRUST` friction/trust · `PERF` perceived
performance/delight.

| # | Recommendation | Lens | Impact | Effort | Priority |
|---|----------------|------|--------|--------|----------|
| R1 | Agent-completion + needs-input **notifications** (OS + in-app) | HAB | Very High | M `+backend` | **P0** |
| R2 | New **"needs input / needs review" workspace status** + StatusDot | HAB | Very High | M `+backend` | **P0** |
| R3 | Cross-repo **Activity / "Needs you" home** | HAB | High | M–L | **P0** |
| R4 | **Reliable re-entry**: restore real last workspace + self-heal worktree | TRUST | High | S (fe) + M (`+backend` self-heal) | **P0** |
| R5 | **Optimistic task start** + clone/setup progress | PERF | High | M | P1 |
| R6 | **Guided first-diff "aha"** (prefilled prompt, "review here" cue, no empty-repo dead-end) | ACT | High | M | P1 |
| R7 | Promote **Merge / Open PR** out of the ⋯ menu into a visible "Ship" action | TRUST/HAB | Med-High | S–M | P1 |
| R8 | **Undo window** on destructive delete | TRUST | Med-High | M `+backend` (soft-delete exists) | P1 |
| R9 | Merge-conflict **"Open terminal" affordance** (kill the dead-end) | TRUST | Med | S | P2 |
| R10 | **Lower the sign-in gate** (evaluate-before-auth or sell the value on the gate; fix hidden default location) | ACT | Med | S–M `+product` | P2 |
| R11 | Finish **feedback polish**: global reduced-motion, run-cmd restart, live status pulse | PERF/TRUST | Low-Med | S | P2 |

---

## If You Only Do 3 Things

1. **Make the agent reach out to you (R1 + R2).** Add a "needs input / needs review"
   status and fire an OS notification when an agent finishes or pauses. Today phasr gives
   *zero* signal on completion — this is the highest-leverage change in the whole product
   and directly creates the daily-return habit.
2. **Make coming back reliable (R4).** Restore the *actual* last-open workspace (not the
   newest) and self-heal a missing worktree so relaunch never dead-ends on "✗ Failed to
   start." Re-entry is the retention moment; it's currently the most fragile surface.
3. **Compress and guide the first "aha" (R5 + R6).** Navigate optimistically to a skeleton
   the instant a task starts, prefill a runnable first prompt, and point the new user at
   the Changes panel. Get them to their first agent-produced diff faster, and make the
   payoff legible.

---

## Detailed Recommendations

### R1 — Agent-completion & needs-input notifications  · HAB · Very High · M `+backend`

**Problem.** Nothing tells the user when work happens. An agent can finish, exit non-zero,
or pause waiting for the user to type — and unless the window is focused *and* the user is
staring at that terminal, they never know. Confirmed: `sendNotification`/`Notification`
appears nowhere in `src/` (only a `--z-toast` comment and toast `aria-label`s). The exit
event already exists (`Terminal.tsx:215` handles `event.exitCode` → `onExit`), so the
signal is available — it just dies in the UI.

**Why it matters for retention.** The entire value prop is "launch agents and let them
work." Without completion signals, phasr forces synchronous babysitting, which caps how
many agents a user will trust to run and kills the reason to keep the app open in the
background. Notifications are the mechanism that pulls a user *back* — the definition of a
habit loop.

**Design.**
- On agent exit / idle / awaiting-input, fire a native notification via
  `@tauri-apps/plugin-notification`: *"claude finished — fix login redirect bug (3 files
  changed)"* → clicking it deep-links to that workspace's Changes panel.
- In-app: a count badge on the app icon / TitleBar and a per-repo "needs you" dot in the
  sidebar (feeds R3).
- Respect focus: suppress the OS notification if that workspace's terminal is already
  focused (no notification for what you're watching).
- Settings toggle (per-agent, and a global mute) — devs are notification-sensitive; make
  it opt-in-friendly, not spammy. Default: notify on **finish**, **fail**, and
  **needs-input**, not on routine output.

**Handoff.** Design owns the notification copy matrix + click-through target + settings UI;
`tauri-engineer` owns the backend "agent became idle/awaiting-input" detection and the
plugin wiring. Pairs tightly with R2 (the status *is* the notification trigger).

---

### R2 — "Needs input / needs review" workspace status  · HAB · Very High · M `+backend`

**Problem.** `WorkspaceStatus` is `pending | running | stopped | completed | failed |
archived` (`src/lib/types.ts:4`). There is **no state for "the agent is waiting on you."**
`StatusDot.tsx` pulses `running` → `--color-info` for *both* a hard-working agent and one
that's been blocked on a prompt for 10 minutes. The most important thing a user needs to
know at a glance — *which agents need me right now* — is invisible.

**Why it matters.** This is the at-a-glance signal that makes phasr scannable and turns the
sidebar into a worklist. It's also the trigger for R1 and the grouping key for R3. Without
it, running many agents (the power-user behavior that drives retention) is unmanageable.

**Design.**
- Add two derived states surfaced in the UI: **`needsInput`** (agent paused for a prompt)
  and **`needsReview`** (agent finished with uncommitted changes — i.e. `completed` +
  `changeCount > 0`). `needsReview` can be derived frontend-side today from
  `useGitStatus`; `needsInput` needs a backend heuristic (PTY idle after a prompt).
- `StatusDot`: give `needsInput` a distinct **coral** dot (the accent — scarce, high-signal,
  "this one is about you") with a gentle pulse; `needsReview` a solid **success/coral** dot
  with a small count. Keep color + shape + `aria-label` (the audit's color-only rule).
- Sort the sidebar workspace list so `needsInput`/`needsReview` float to the top within
  each repo.

**Note.** Because StatusDot already keys off `status` and has an `aria-label`, the frontend
cost is small once the states exist. The value is enormous relative to effort.

---

### R3 — Cross-repo Activity / "Needs you" home  · HAB · High · M–L

**Problem.** Home (`src/routes/_app/index.tsx`) either shows the Welcome state (zero repos)
or **force-navigates into a single workspace** (`Navigate ... replace`, line 36) — the
newest one. There is no vantage point to see all in-flight agents. A returning power user
is dropped into *one* terminal with no idea that two other agents finished and one failed.

**Why it matters.** A home base is what makes a multi-agent workflow a *daily* workflow.
"Open the app → see 2 need review, 1 needs input, 3 still running → triage" is the habit
loop. Right now that triage is impossible without manually clicking through the sidebar.

**Design (2 directions, recommend A):**
- **A — "Inbox" home (recommend).** Replace the force-navigate with a light activity home:
  workspaces across *all* repos grouped by attention: **Needs you** (needsInput +
  needsReview), **Running**, **Recent**. Each row = StatusDot + name + repo + branch +
  relative time + change count; click → workspace. Reuse `PanelState` for the empty case
  and the existing `StatusDot`. Keyboard-navigable (j/k, Enter) to stay Linear-fast.
  *Best when:* the user runs several agents — the target power user. *Tradeoff:* one extra
  click for the single-workspace user (mitigate: a "jump to last workspace" affordance and
  R4's restore).
- **B — Keep auto-open, add a peek.** Keep the bounce-into-workspace but add a persistent
  "activity" popover in the TitleBar showing the same grouped list. *Best when:* most users
  are single-tasking. *Tradeoff:* the survey view is hidden behind a click; less of a home.

**→ Recommendation: A**, gated on R4 so returning single-taskers still land fast. The Inbox
*is* the retention surface; the peek (B) can layer on later for in-workspace glancing.

---

### R4 — Reliable re-entry  · TRUST · High · S (fe) + M `+backend`

**Problem (two bugs, one felt experience).**
1. Home restores the **wrong** workspace: `workspaces?.[0]` = newest of the most-recent
   repo (`index.tsx:33`), not the one you were actually in. The `phasr.lastWorkspace`
   persistence that memory says shipped is **absent from the current code** (no
   `lastWorkspace` key in `store.ts`; store only persists sidebar/panel geometry).
2. The known relaunch failure — worktree missing → `✗ Failed to start: not found` /
   `RepositoryPathMissing` — still dead-ends because worktree self-heal (B3) is deferred.
   `TerminalStatus` now shows a recoverable "Couldn't start / Retry" (good), but Retry
   can't succeed if the worktree is genuinely gone.

**Why it matters.** Re-entry is *the* retention moment. Landing on the wrong workspace, or
on a broken terminal, on every relaunch teaches the user the tool is flaky — the fastest
way to lose a daily user. This is a trust tax paid on every single session.

**Design.**
- **Restore the real thing (S, frontend now):** persist `{repositoryId, workspaceId}` on
  every workspace mount (`setActiveWorkspaceContext` already fires in
  `$workspaceId.tsx:55`) and, on launch, validate + navigate there; fall back to R3's home
  (not the newest workspace) if it's gone. Never silently force-open a different workspace.
- **Self-heal the worktree (M, `+backend`, B3):** when `open_terminal`/`cwd_for_task` finds
  the worktree missing but the branch exists, recreate it from the branch under the repo
  lock; only if that fails, show a *calm* `PanelState`: "This workspace isn't available on
  this machine" + [Recreate] / [Remove] — never a raw-ANSI dead-end.
- Also close the latent multi-machine `worktree_path` copy (B2) so cloud-synced workspaces
  don't point at another machine's path.

**Handoff.** Frontend restore is a design-owned quick win this week; B2/B3 escalate to
`tauri-engineer` (already scoped in the relaunch-restore backlog).

---

### R5 — Optimistic task start + setup progress  · PERF · High · M

**Problem.** `startTask` (`NewTaskForm.tsx:82`, `CreateFirstWorkspacePane.tsx:96`) does the
whole round-trip — create workspace row, create worktree, spawn PTY — **before** the UI
navigates. The button sits on "Starting…" with no scene change. For **clone**
(`NewProjectPane.tsx:127`) it's worse: a potentially multi-minute operation behind a single
"Cloning…" label with no progress and no cancel.

**Why it matters.** First impressions of speed set the perceived quality of the whole tool
(the Linear bar). A blocking spinner on the very first action makes phasr feel heavier than
it is; a snappy optimistic transition makes it feel alive.

**Design.**
- On submit, **navigate immediately** to the workspace route showing a skeleton +
  `TerminalStatus state="starting"` (which already exists and is auto-focused). Reconcile
  when the real record lands; surface failure via the same overlay's `failed` state.
- Clone/template setup: show real phases — *Cloning… → Setting up worktree… → Launching
  agent…* — using the existing glass surface, with an indeterminate bar and, ideally, a
  cancel. Even coarse phase labels beat one static verb.
- Keep the change-count badge (`$workspaceId.tsx:258`) as the live "something happened"
  pulse once the agent starts writing.

---

### R6 — Guided first-diff "aha"  · ACT · High · M

**Problem.** The first-run path (`CreateFirstWorkspacePane`) is well-labeled but the moment
of magic — *the agent produced a diff you can review* — is unguided. Nothing points the
new user at the Changes panel (it's collapsed by default unless there are changes, and the
toggle is a quiet header button). Worse, the New Project **Empty** mode
(`NewProjectPane.tsx:112`) creates a blank repo where the agent has nothing meaningful to
do, producing a hollow first experience. And the default project location is a hidden
dotfolder `~/.phasr/projects` (`NewProjectPane.tsx:72`) — invisible in Finder, mildly
disorienting.

**Why it matters.** Activation = reaching the "aha" fast *and recognizing it*. A new user
who kicks off an agent and then stares at a terminal without realizing the diff panel is
the point will churn before the value lands.

**Design.**
- **Prefill a runnable first prompt** in the first-workspace form (a real, safe example
  like "Add a README with setup instructions") so a single Enter produces a visible diff —
  the fastest possible path to a real change.
- **Point at the payoff:** when the first agent-produced change appears, auto-open the
  Changes panel once (or a one-time coral coachmark on the Changes toggle): "Your agent's
  changes show up here — review, then commit or open a PR."
- **Steer away from the empty-repo dead-end:** de-emphasize Empty for first-timers, or if
  chosen, seed a starter file so the agent has ground to stand on. Prefer Clone/Open-existing
  as the first-run default (a real repo = a real aha).
- Surface the default location as a readable path with a note ("hidden app folder — change
  if you like"), fixing the FORMS-D5 dotfolder opacity.

---

### R7 — Promote Merge / Open PR out of the ⋯ menu  · TRUST/HAB · Med-High · S–M

**Problem.** The loop's *reward* — Merge to main, Open pull request — lives inside the
`MoreHorizontal` overflow menu (`WorkspaceActionsMenu.tsx:182,194`), next to Archive and
Delete. The payoff of a whole agent run is a hidden, undifferentiated list item.

**Why it matters.** Completing the loop is what makes the work feel *worth it* and what
brings the user back for the next task. Burying it flattens the reward and makes shipping
feel like admin. (Audit item WS-E3 flagged this; it's a retention lever, not just craft.)

**Design.**
- When `branchStatus.aheadOfTarget > 0` and nothing blocks it, show a visible **"Ship"**
  affordance in the workspace header (a primary/secondary `GlassButton`, not accent-spammed)
  that opens Merge, with Open PR one step away. Keep destructive actions in ⋯.
- Give it a small celebratory beat on success (the existing 800ms success hold in
  `MergeToMainDialog` + a toast "Merged into main") — the loop should *close* with a felt win.
- Keep it contextual: hide entirely for local workspaces and when there's nothing to ship
  (the `mergeBlocked` logic already exists at `WorkspaceActionsMenu.tsx:85`).

---

### R8 — Undo window on destructive delete  · TRUST · Med-High · M `+backend`

**Problem.** Delete stops the agent, removes the worktree, and **deletes the branch and its
commits** (`WorkspaceActionsMenu.tsx:143`). The confirm copy is excellent (post-audit), but
confirm dialogs cause "yes-fatigue" — and once confirmed, it's irreversible. Archive is
recoverable; delete is a cliff.

**Why it matters.** Reversibility, not friction, is what builds trust in destructive tools
(the Gmail-undo principle). A user who has lost an agent's work once will hesitate on every
delete thereafter — or worse, stop trusting the tool with real work.

**Design.**
- Replace (or back) the confirm with an **optimistic delete + 5–8s Undo toast**: remove the
  row from the UI immediately, defer the actual worktree/branch destruction, and offer
  **Undo** in the toast (the toast system already supports action buttons + hover-pause
  from the audit's Batch 3).
- Feasible now: the recent `feat(sync): soft-delete workspaces` commit means a soft-delete
  tombstone already exists — lean on it to make the destroy *deferred* rather than immediate.
- Keep a hard confirm only for the truly unrecoverable case (unpushed commits — already
  detected at `WorkspaceActionsMenu.tsx:133`).

---

### R9 — Merge-conflict "Open terminal" affordance  · TRUST · Med · S

**Problem.** A conflicted merge ends at explanatory copy: "Resolve via the terminal — Phasr's
conflict resolver only operates inside a workspace worktree"
(`MergeToMainDialog.tsx:100`). Correct, honest — but a **dead-end**. The user is told to go
somewhere with no button to get there (residual GIT-D4).

**Why it matters.** A dead-end at the highest-stakes moment (a conflict during ship) is
exactly where trust erodes. Turning explanation into action keeps the loop recoverable.

**Design.** Add a primary **"Open terminal to resolve"** button in the conflict note that
opens a terminal in the main checkout, plus a one-line "how to finish" hint. Cheap, and it
converts the app's most anxious moment into a guided path.

---

### R10 — Lower the sign-in gate  · ACT · Med · S–M `+product`

**Problem.** `DesktopSignIn` is a **hard gate** in front of the entire app (whole tree behind
AuthGate) — OAuth-only (Google/GitHub), requiring a browser round-trip
(`DesktopSignIn.tsx:166`) before the user sees *anything* of value. A developer evaluating a
new local dev tool must authenticate before learning what it does.

**Why it matters.** Every gate before first value is an activation drop-off. For a
locally-run tool, forcing cloud auth up front is a big ask relative to the payoff the user
hasn't seen yet.

**Design (product decision — escalate to POPM):**
- Ideally, let a user reach *first value* (create a repo, run one agent locally) **before**
  requiring sign-in, and gate only cloud-sync features. If auth must stay a hard gate, then
  **sell the value on the gate**: the sign-in screen currently says only "Welcome to Phasr /
  Sign in to get started" (`DesktopSignIn.tsx:209`) — add a one-line value prop and a
  1-screen "what you get" so the ask has context.
- The "waiting for browser" state now has a Cancel (good) — keep hardening that round-trip
  (clear timeout/retry, inline error already added).

---

### R11 — Finish the feedback polish  · PERF/TRUST · Low-Med · S

Small items that compound into "this tool feels considered":
- **Global `prefers-reduced-motion`** (R2-A2, still open) — the sidebar width transition,
  `modal-in`, and `pulse-dot` animate unconditionally. One CSS rule; respects accessibility
  and stops motion sickness for the always-on power user.
- **Restart on finished run-commands** (WS-D4) and a live status pulse so a completed run
  command isn't a static dot with no next action.
- **Live theme re-theming of mounted terminals** (R2-N5) — verify a theme switch repaints
  open xterms, so the app never looks half-dressed after toggling.

---

## Which Shipped-but-Deferred Audit Items Most Move Retention

The audit was craft-focused; most residual items are polish. Ranked by *retention* value:

| Audit item | Why it moves retention | Maps to |
|---|---|---|
| **Relaunch B2/B3** (worktree self-heal, multi-machine `worktree_path`) | Kills the re-entry trust-breaker — the #1 felt-reliability issue | **R4** |
| **WS-E3** (Merge/PR buried in ⋯) | The loop's payoff is hidden; surfacing it closes the habit loop | **R7** |
| **GIT-D4** (merge-conflict "Open terminal") | Converts the highest-anxiety dead-end into a recoverable action | **R9** |
| **WS-C5 / WS-D4** (restart exited agent / run cmd) | Partly delivered via `TerminalStatus` restart; finishing it keeps sessions resumable | R11 |
| **FORMS-D5** (hidden dotfolder default location) | Small activation-clarity win in the first-project flow | **R6** |
| **R2-A2** (global reduced-motion) | Comfort for the always-on user; a11y | **R11** |
| **SHELL-B1** (dead breadcrumb / no wayfinding) | Orientation across repos/workspaces; supports the Inbox home | R3 |

**Net-new (not in the audit — because they're experience architecture, not craft):**
R1 notifications, R2 needs-you status, R3 activity home, R5 optimistic start, R6 guided aha,
R8 undo. These are where the retention ceiling actually lives.

---

## Appendix — Activation Funnel Map (time-to-first-diff)

Each arrow is a drop-off risk; annotations are the friction found in code.

```
Launch
  │
  ▼
Sign in  ── HARD GATE, OAuth-only, browser round-trip        [R10]
  │        DesktopSignIn.tsx — no value prop, no evaluate-first
  ▼
Welcome  ── two cards, no sample/demo, no "jump back in"     [R3, R6]
  │        index.tsx WelcomeState
  ▼
Get a repo
  ├─ New project ── Empty = blank repo (hollow aha);          [R6]
  │                 default location = hidden dotfolder
  │                 NewProjectPane.tsx
  └─ Open existing ── best first-run path (real repo = real aha)
  │
  ▼
(if not git) GitInit confirm modal
  │
  ▼
Create first workspace ── 2 steps (name+branch → agent+prompt); [R6]
  │                        prompt optional → agent with no task
  │                        CreateFirstWorkspacePane.tsx
  ▼
Start task ── BLOCKING round-trip, no optimistic nav;          [R5]
  │           button stuck on "Starting…"
  ▼
Live terminal ── agent runs… with NO completion signal         [R1, R2]
  │
  ▼
★ FIRST DIFF (the aha) ── Changes panel is quiet/collapsed;     [R6]
  │                       nothing points the user here
  ▼
Review → Commit → Merge/PR ── reward buried in ⋯ menu          [R7]
```

**The compression targets:** R10 (gate), R5 (blocking start), R6 (unguided aha + weak
empty-repo path). **The habit targets:** R1/R2 (the vacuum after start), R3 (no home base),
R4 (fragile re-entry).

---

*Analysis only — no code changed. Handoffs: frontend quick wins (R4 restore, R6 cues, R7
surface, R9 button, R11) → `fe-developer`; backend triggers/self-heal (R1 detection, R2
needs-input, R4 B2/B3, R8 deferred destroy) → `tauri-engineer`; gate/auth scope (R10) →
POPM. R1+R2 should be designed together as one "the agent reaches out to you" DDR.*
