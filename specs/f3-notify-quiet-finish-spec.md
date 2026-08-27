# Spec: Track F3 — Notify on quiet / on finish

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** F (features) · **Ships as:** 0.5.x · **Size:** ~2 days
**Depends on:** F1 (status transitions) and F2 (prompt marks) as *signal sources* — degrades
to the output-quiet timer if either is absent. Lands right after F2's first slice.
**Provenance:** derived from a local iTerm2 source read, 2026-08-27
(`iTermNotifyOnStatusChangeController.swift`).

## Objective

A **one-shot** "tell me when this settles" per session, armed by the user, delivered through
the notification route phasr already owns.

The existing completion notification fires when a *task* completes
(`src/lib/hooks/useCompletionNotifications.ts`, on the `phasr://task-status` stream). This is
different: it is armed on demand, for a session that is *already running*, and it fires when
that session goes quiet — which is what a developer waiting on a long agent turn actually
wants.

## User story

- As a developer who just told an agent to do something slow, I want to arm "ping me when
  this settles" and go do something else, so I do not sit watching a spinner.
- As a developer, I do not want the ping to fire immediately because of something that was
  already happening when I armed it.
- As a developer, I do not want a ping from a state that flickered and came straight back.

## Triggers (any one fires the armed notification)

1. **Next prompt mark** — F2's OSC 133 `A`/`D`: the command finished.
2. **Status transition** — F1's model: e.g. `working` → `waiting`, or `working` → `idle`.
3. **Output-quiet timer** — fallback, and the only trigger available without F1/F2: no bytes
   for N seconds. iTerm2's idle definition is **2 s + 1**; adopt that as the default and make
   it configurable.

## The two non-obvious correctness bits (copy them; they are the whole feature)

### Arm-time baseline

A change **already in flight** when the user arms must not fire the notification instantly.
On arm, capture the current state — last-output timestamp, current status, the id of the
currently-open command mark — and only fire on a transition *away from that captured
baseline*. Without this, arming during a quiet moment fires immediately and the feature is
useless.

### 50 ms debounce

An A→B→A flicker must net to **nothing**. A status that changes and changes back inside the
debounce window is not a transition. Same window as F1's UI debounce, for the same reason:
tool-use bursts produce many events in a few milliseconds.

## Acceptance criteria

1. **Arm/disarm from two surfaces**: the task board and the terminal itself. Armed state is
   visible (the user can tell it is armed) and disarmable.
2. **One-shot**: firing disarms. A session does not ping twice from one arm.
3. **Arm-time baseline holds**: arming during an in-flight change does **not** fire
   immediately. Asserted with a test that arms mid-burst and requires silence until a genuine
   new transition.
4. **50 ms debounce holds**: a scripted A→B→A inside 50 ms fires **nothing**; the same
   sequence spread over 200 ms fires once.
5. **All three triggers work**, and each is independently testable.
6. **Degrades cleanly**: with F1 and F2 absent or unavailable for a session (e.g. a non-Claude
   command with no shell integration), the output-quiet timer alone still arms and fires.
7. **Delivery goes through the existing route-registration seam**, not a new notification
   path: `src-tauri/src/commands/notifications.rs` —
   `NotificationRouteRegistry` (:64), `register_notification_route` (:143),
   `activate_notification` (:164), `NOTIFICATION_ACTIVATED_EVENT` (:48),
   `NotificationActivatedPayload` (:100). Clicking the notification navigates to the right
   session, exactly as agent-completion notifications already do.
8. **Respects OS permission state**: uses the existing gate
   (`src/lib/notificationPermission.ts` — `initNotificationPermissionState`,
   `osNotificationsGranted`). With OS notifications denied, the in-app toast path still works.
9. **Does not double-notify with agent-completion.** If a session both completes as a task
   and fires an armed quiet-notification, the user gets **one** notification. The existing
   controller already suppresses when the user is viewing that workspace
   (`useCompletionNotifications.ts`); this feature must compose with that rule rather than
   bypass it.
10. **Disarms on session end.** A session that exits while armed does not leave a dangling
    timer or fire after teardown.

## #PATH_DECISION — reuse the notification route registry, do not add a channel

`src-tauri/src/commands/notifications.rs` already owns route registration and the
`phasr://notification-activated` event whose payload shape the frontend listener destructures
(the file says so at :95). Adding a second notification mechanism would duplicate the
click-routing logic and the permission gating, and would create the double-notify bug in
criterion 9 by construction.

**Decision: this feature is a new *trigger* feeding the existing delivery path.** No new
notification transport, no new activated-event shape.

## #PATH_DECISION — Q7: the quiet *timer* is Rust-side; the arm/fire *state machine* is not

**Decision (2026-08-27, System Architect): (a) — the quiet timer lives in Rust, off
`last_output_at`. The one-shot/baseline/debounce state machine stays in the frontend, and owns
the decision to fire.**

Verified: `last_output_at` is an `AtomicI64` **on `PtyHandle`** (`src-tauri/src/pty/handle.rs`,
constructed at `:225`), stamped by the coalescer at *receipt* — before any framing or delivery
decision (`:740`, "Stamped at receipt, not at flush"). It is therefore independent of every
mechanism P4 touches: LRU eviction destroys a JS surface, and P4 criterion 7 tears down the
Rust *forwarder*, but neither touches the handle. A frontend timer built on surface write
callbacks dies with the surface — and the feature's entire premise is "arm it and go look at
something else", i.e. the exact moment the LRU parks or evicts that surface.

**The split, and why it is not all-Rust:** F3 has three triggers, and two of them (F1 status
transitions, F2 marks) are observed frontend-side. One-shot-ness (criterion 2), the arm-time
baseline (criterion 3), the 50 ms debounce (criterion 4) and the no-double-notify composition
with `useCompletionNotifications` (criterion 9) all require **one owner**; splitting the state
machine across the IPC boundary re-creates the double-fire bug by construction. So Rust emits
a *signal* — "task X has produced no bytes since the arm baseline for N ms" — and the frontend
reducer decides. Both halves stay unit-testable against a fake clock, which is what criteria
2–6 and 10 assert.

Implementation notes that follow from it:

- Arm/disarm is a Tauri command keyed by the **PTY handle key**, not the task id alone: the
  same mechanism must serve session terminals and run-command terminals
  (`commands/session_terminal.rs`, `commands/run_commands.rs`), which have handles but are not
  tasks. `list_task_activity` (`commands/orchestrator.rs:61`) covers tasks only and its 60 s
  poll is far too coarse for a 2 s + 1 quiet window — **do not** build the trigger on it.
- The armed watcher is one small tokio task per armed session, with the quiet window as its
  tick; it stops on fire, on disarm, and on `PtyEvent::Exit` (criterion 10).
- Session end must disarm in *both* halves; assert the Rust half separately.

**Rejected — (b) frontend-side timer:** dies with the surface (`src/lib/terminal/cache.ts`),
which is precisely when the user needs it. Not acceptable even as a first slice, because
"armed only while you are looking at it" inverts the user story.
**Rejected — the whole state machine in Rust:** the F1/F2 triggers are frontend-observed, so
this would put the one-shot rule in the process that cannot see two of its three inputs.

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| Notification route registry + activation | `src-tauri/src/commands/notifications.rs` — `NOTIFICATION_ACTIVATED_EVENT` (:48), `NotificationRoute` (:55), `NotificationRouteRegistry` (:64), `RegisterNotificationRouteInput` (:87), `NotificationActivatedPayload` (:100), `register_notification_route` (:143), `activate_notification` (:164) |
| Registry registration | `src-tauri/src/lib.rs:55` (`.manage(...)`), handlers at `:188–189` |
| Existing completion-notification controller (must compose, not conflict) | `src/lib/hooks/useCompletionNotifications.ts` — listens on `phasr://task-status`, suppresses when the workspace is being viewed |
| OS permission gate | `src/lib/notificationPermission.ts` |
| In-app toast path | `src/lib/toast.ts` (`showToast`, `ToastIntent`) |
| Task status payload | `src/lib/types.ts` — `TaskStatusPayload` (`taskId`, `repositoryId`, `status`, `exitCode`) |
| Quiet-timer source (option a) | `src-tauri/src/pty/handle.rs:740` — `last_output_at.store(epoch_ms(), Relaxed)` in the coalescer |
| Debounce precedent | F1's 50 ms status debounce; `src/lib/hooks/useDebouncedValue.ts` |
| Signal source — status | F1 (`specs/f1-agent-status-hooks-spec.md`) |
| Signal source — prompt marks | F2 (`specs/f2-command-marks-osc133-spec.md`) |

## Test / evidence plan

- **vitest** (`pnpm test`) — the primary suite: the arm/baseline/debounce state machine as a
  pure reducer. Every acceptance criterion 2–6 and 10 is expressible as a scripted event
  sequence against it with a fake clock. `useCompletionNotifications` has no existing test
  file; add coverage for the composition rule in criterion 9.
- **Rust** (`cargo test`): if the quiet timer lands Rust-side, unit-test the arm→baseline→fire
  sequence against a fake clock and `last_output_at`.
- **Playwright** (`e2e/harness.ts`): arm from the UI, push scripted status/mark events through
  the mocked IPC, assert the toast appears once and routes correctly on click. **Limitation:**
  the harness cannot deliver a real OS notification — only the in-app toast half and the
  route payload are observable there.
- **Manual:** OS-level notification delivery, click-to-navigate on a packaged build, and the
  denied-permission path. Add a `docs/MANUAL-VERIFICATION.md` entry.

## Out of scope

Recurring/persistent notifications (this is one-shot by design) · notification content
customization · per-repository notification policies · notifying on *start* · Do Not Disturb
integration · changing agent-completion notification behaviour beyond the composition rule in
criterion 9.
