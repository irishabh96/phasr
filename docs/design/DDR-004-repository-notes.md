# DDR-004: Repository Notes — a rail that stays open while you work

**Status:** Implemented (`feat/keymap-and-repo-notes`) · **Date:** 2026-08-04 · **Mode:** DESIGN
**Builds on:** DDR-002 (glass panels, PanelState, toast system), the existing right rail.
**Spec:** `specs/repository-notes-spec.md`

---

## Brief

- **User** — a developer running one or more AI agents against a repository in phasr.
- **Job-to-be-done** — jot down and recall repo-specific knowledge (setup quirks, the
  command that actually works, decisions, gotchas) *without leaving what I'm doing*.
- **Success criteria**
  1. Capture a note from any surface without losing terminal focus context.
  2. **Recall a note while typing in a terminal** — the surface must not block.
  3. Provenance is legible at a glance and survives workspace deletion.
  4. Zero notes lost: drafts survive rail collapse; save failures keep the text.
- **Constraints** — reuse `GlassButton`/`GlassTextarea`/`ConfirmDialog`/`PanelState`/
  `GlassTooltip`/`ResizeHandle`. Flat direction. Light + dark parity, AA in both.

---

## Direction chosen: "Notes Rail" (A)

Notes is a **third tab in the existing workspace right rail** (Changes · History ·
Notes), and the same rail — Notes only — is added to repo home.

```
WORKSPACE VIEW                                    REPO HOME
┌──────────────────────────┬───────────┐          ┌──────────────────┬───────────┐
│ BranchChip │ tabs… │ 📓 ⧉│Chg Hist ▸No│         │ [Home][Term 1] 📓 +│  Notes    │
├──────────────────────────┼───────────┤          ├──────────────────┼───────────┤
│  terminal / agent        │ composer  │          │  repo home       │ composer  │
│  (keeps focus, visible)  │ ───────── │          │  content         │ ───────── │
│                          │ note      │          │                  │ note      │
└──────────────────────────┴───────────┘          └──────────────────┴───────────┘
```

**Alternatives rejected.** A global slide-over drawer and a "notes as an inner tab"
both *cover the terminal* — you can't read a note while typing the command it
describes, which is success criterion 2. The inner-tab variant also duplicates one
repo-scoped list into N per-workspace tabs. A bottom dock fights `RunCommandsPane`
for the same edge and gives prose a 1200×280 reading measure.

**Two structural changes it required**, both independently correct:
1. The workspace `<aside>` is no longer gated on `workspace.worktreePath` — notes must
   be reachable on a pending/worktree-less workspace. Changes/History render their own
   "No worktree yet" `PanelState` instead of the entire rail disappearing.
2. Repo home gained a rail, sharing the `RIGHT_PANEL_WIDTH_*` store keys.

---

## Entry points (four, all repo-scoped)

| Context | Entry |
|---|---|
| Workspace (any inner tab, incl. terminal) | `NotebookPen` ghost icon button in the header cluster, left of the Changes toggle |
| Repo home (incl. repo terminals) | Same button pinned right in `RepoInnerTabBar`, before the `+` |
| Anywhere | `⌘⇧N` (`SHORTCUTS.openNotes`) — opens the rail on Notes and focuses the composer |
| Anywhere | ⌘K → "Repository notes"; **disabled with "Open a repository first"** when there's no repo context — never silently absent |
| Sidebar | Repo row context menu → "Notes" |

---

## Anatomy

Sticky composer on top; newest-first, hairline-divided rows below (not cards — in
light theme `--color-bg-surface` and `--color-bg-elevated` are both `#ffffff`, so a
card is invisible without a border, and a grid of bordered gray boxes is exactly the
templated look the design system warns about). Filter input appears past 8 notes.

Each row: body (13px, `pre-wrap`, `break-words`, clamped to 8 lines + "Show more"),
then an 11px muted meta line — origin icon · origin label · workspace name ·
relative time (absolute on hover/focus) · "edited" — and always-visible ✎/🗑 ghost
icon actions.

**Accent budget: three uses.** Active-tab underline, the Save button, the focus ring.
The tab count is a plain `--color-text-secondary` numeral and the entry button carries
**no badge** — a note count is not urgent and must not compete with the coral Changes
pill.

---

## State coverage

| State | Behavior |
|---|---|
| Loading | `PanelState kind="loading"` skeleton, 3 rows |
| Empty (first run) | `PanelState` + `NotebookPen`: "No notes for this repository" / "Jot down anything about this repo… Notes stay with the repository, not the task." + "Write a note" CTA that focuses the composer |
| Empty (filtered) | "No notes match “…”." + "Clear filter" |
| Load error | `PanelState kind="error"` (`role="alert"`) + Retry |
| Editing | Inline `GlassTextarea`, `⌘↵ to save · Esc to cancel`; Save disabled when unchanged (`title="No changes to save"`) |
| Save failed | **Text preserved**, danger strip (`role="alert"`) + Retry |
| Deleting | `ConfirmDialog destructive` quoting the note's first 80 chars, **initial focus on Cancel** |
| Long body | 8-line clamp + Show more/less; a 200-char unbroken token never widens the rail (`[overflow-wrap:anywhere]`) |
| Near/at cap | Counter past 45k chars; danger-colored and Save disabled at 50k |
| Workspace removed | Provenance renders from the **snapshot**, plus a muted `Removed` chip (not danger-colored — it's history, not an error) with "This workspace no longer exists." |
| Draft + rail collapse | Draft persisted in `useUiStore.noteDrafts`, restored verbatim |

---

## Two bugs this work surfaced (both fixed)

1. **The composer moved the list out from under the pointer.** It grew on *focus* and
   shrank on blur, so clicking a note's Edit/Delete blurred the composer, collapsed it
   ~60px, and the click landed on empty space — reproducible by hand, caught by
   Playwright (the click's `e.target` was the scroll container). Height is now a pure
   function of **content**, never focus.
2. **`ConfirmDialog` focused its destructive action on open** (`Dialog.tsx` picks the
   last footer button), so Enter-through deleted. Destructive dialogs now focus Cancel.

## Accessibility

All pairs clear AA in both themes. One net-new token was required:
`--color-danger-text` — the light-theme save-error strip put `#dc2626` on a 12% danger
tint at **4.01:1** (fail); `#b91c1c` is **5.37:1**. Dark keeps the vivid token (6.37:1).
`--color-accent-text` is deliberately never used for text here — in light theme it is
4:1, fine for its current icon-only uses (3:1 bar) but a loaded gun for 11–13px copy.

`aside aria-label="Repository notes"` · `<ul role="list">` with per-note
`<article aria-label="Note from Terminal 2, fix-auth, 3 hours ago">` ·
`<time dateTime>` + tooltip (fires on focus, so keyboard users get the absolute time) ·
`aria-live="polite"` announces "Note saved" · error strips are `role="alert"` ·
`⌘↵`/`Esc` in every editor, never a focus trap outside the confirm dialog.

## Follow-ups (not in v1)

Roving-tabindex arrow navigation over the list · markdown rendering · search beyond the
substring filter · trash/restore UI · sort toggle. See the spec's Out of Scope.
