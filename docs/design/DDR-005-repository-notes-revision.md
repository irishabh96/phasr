# DDR-005: Repository Notes — reading surface, summoned capture

**Status:** Implemented · **Date:** 2026-08-05 · **Supersedes:** DDR-004 (anatomy, entry points, states)
**Direction retained from DDR-004:** rail + third tab. **Direction replaced:** composer-on-top.

---

## Why the first pass failed review

DDR-004 described a DOM tree ("sticky composer on top, hairline-divided rows
below") and the implementation rendered it literally. The result: the loudest
element in a *reading* panel was an empty input wearing a coral focus ring; rows
were a paragraph plus a middot-separated grey meta line with no hierarchy;
actions cluttered every row at rest; and past a handful of notes it became an
undifferentiated wall with a grey void beneath it.

It also shipped five defects, all fixed here:

| | Defect | Why it mattered |
|---|---|---|
| 🔴 | `isLong` counted **hard newlines**; the clamp is **visual** | Any single paragraph past ~320 chars was clipped by CSS with no "Show more" — the text was unreachable in a feature whose whole job is recall |
| 🔴 | Empty-state CTA called `focus()` on an already-focused field | A dead button, plus a fourth accent use fighting the composer for one action |
| 🔴 | Focus ring used `accent-500`/`accent-300` | 2.53:1 / 1.87:1 on white — below the 3:1 non-text minimum, so light-theme keyboard focus was invisible |
| 🔴 | Tooltips on non-focusable `<time>`/`<span>` | Radix's trigger adds no `tabindex`, so "this workspace no longer exists" was mouse-only — DDR-004's a11y claim was false |
| 🔴 | No keyboard model for the list | 30 notes = 60 tab stops, no ↑/↓, no ↵ — in a keyboard-first product |

## The design

**The panel is a reading surface. Capture is summoned.** `⌘⇧N`, the header `+`,
or clicking the canvas opens a composer as row zero, under today's group header.
The resting panel contains **no accent colour at all** — the only coral in the
region is the active-tab underline in the strip above it.

```
┌─ rail 300–640px ────────────────────────────────────────┐
│ Changes 3   History   Notes 4                      [+]  │ h-9, action slot
├─────────────────────────────────────────────────────────┤
│ Today                                                   │ sticky group header
│   The seed script silently no-ops when DATABASE_URL …   │ 13/400 primary
│   >_ Terminal 2  add-feature                       ⋯    │ 11 sans + 11 mono
│ Yesterday                                               │
│   Codex rewrites vite.config.ts every run               │ 13/500 title line
│   It ignores the comment banner. Pin the file …         │ 13/400 secondary
│   ⚡ Agent  c̶h̶e̶c̶k̶o̶u̶t̶-̶f̶l̶o̶w̶                    edited  ⋯    │ struck = gone
│ June                                                    │
│   Worktree prune leaves .phasr/worktrees dirs …         │
│   ▶ Run: dev                                    Jun 26  │ day stamp only in
├─────────────────────────────────────────────────────────┤   multi-day buckets
│ + New note                                       ⌘⇧N    │ the canvas: this row
│      (the space below is the same click target)         │ AND the void below
└─────────────────────────────────────────────────────────┘
```

**Borrowed deliberately:** Linear's zero-chrome rows, hover-revealed actions,
roving keyboard, and scarce colour; Notion's typographic rhythm (first line as
title when ≤120 chars) and click-the-empty-space-to-write; Apple Mail's
scroll-away filter; Raycast's teach-the-keystroke-in-place. Explicitly not
taken: display type, gradients, coloured tags, shadows, staggered reveals — in a
300px rail on a dev tool, that decoration *is* the slop.

**Provenance is a type pair, not a chip.** Icon → label (11/500 secondary) →
ref (11 mono muted), reusing phasr's existing mono-for-refs idiom. A pill would
spend 12px of padding to say nothing extra, and its fill would be
`--color-bg-hover` — the same colour as the row hover, so it would vanish
exactly when hovered. A removed workspace is struck through (history, not an
alert) with `sr-only` text and a focusable tooltip; a dashed border was rejected
because `--color-border-strong` is 2.28:1 and can't carry meaning.

**Net-new token:** `--color-focus-ring` (`accent-300` dark / `accent-700` light),
the counterpart to `--color-accent-text` and for the same reason. App-wide: it
fixes every hand-rolled focus ring in light theme.

## Keyboard

`⌘⇧N` summon · `⌘↵` save · `Esc` close (draft kept in `noteDrafts`) ·
`↑`/`↓`/`Home`/`End` move · `↵` edit · `⌫` delete · `⌘C` copy · `/` filter.
One roving tab stop for the whole list.

## Deviations from the review, and why

1. **`⌘↵` closes the composer.** The review wanted it to stay open for rapid
   capture *and* wanted the saved text not to move. Those contradict: with the
   composer above the new note, re-arming it empty pushes the note down by its
   height. Closing it lets the note land exactly where the typed text was;
   re-capture is `⌘⇧N`, which the footer teaches inline.
2. **No optimistic-insert animation.** The "provenance fades in when the write
   confirms" flourish needs an optimistic cache entry with an empty
   `originLabel`. Deferred — the honest-timing idea is good, but it adds a
   failure mode (a stuck optimistic row) for a 180ms effect.
3. **Delete keeps its confirm dialog.** The review argues for delete-then-undo,
   and it's probably right (Linear/Notion both do it), but undo needs either a
   `restore_note` command or an 8s delayed IPC call. Open product decision.

## Open

- Undo-toast vs confirm dialog for delete.
- Should `⌘⇧N` capture without expanding the rail (a 2-row strip)?
- Is strikethrough legible enough for a removed workspace, or should it read
  `(removed)` literally?
