# Mission Control — polish pass (design re-verification)

**Status:** approved — decisions in §2 · **Branch:** `feature/redesign-v2` (PR #37) · **Date:** 2026-11-10
**Supersedes, where they conflict:** the visual parts of `ui-redesign-mission-control-spec.md`.

## 1. Why this spec exists

The design canvas (`d5958bba…`) changed after the redesign was built, and the shipped UI never matched even the first version closely:

| Artboard | Change since the build |
|---|---|
| **A-Polish** | **New.** It holds the ten rules, the neutral palette, the motion and performance spec and the component recap, and is marked "read this first". |
| **Main** (Board) | Redrawn to the Polish rules. |
| **A-Workspace** | Redrawn to the Polish rules. |
| **A-NewTask** | Redrawn: a title, a prompt, and one row of chips. |
| All other A-* artboards | Unchanged. They still use the old blue-grey palette, so the Polish rules apply to them **globally** and their layouts stay. |

Screenshots of the current build, taken in the e2e harness, show it is still on the pre-Polish look on every screen:
- uppercase labels;
- counts in three places;
- filter chips in the sidebar;
- 2-line task rows with mono timers;
- boxed pane tabs;
- the inspector boxed into sections;
- a status bar;
- bordered secondary buttons.

## 2. Decisions (answered 2026-11-10)

| # | Question | Decision |
|---|---|---|
| D1 | The redrawn artboards have no status bar. | **Remove it.** Sync state moves into the account menu, and the bell shows a sync error only when one exists. Key hints stay in tooltips and the palette. |
| D2 | The title bar shows an "Automations" link, but the feature is hidden. | **Keep it hidden** until Automations exists. Board is the only nav item. |
| D3 | The workspace artboard shows a structured transcript; the app shows the agent's TUI. | **Keep the terminal** and polish around it. A transcript is a separate project. |
| D4 | The design's terminal line says "xterm.js + WebGL"; the app uses ghostty-web. | **Keep ghostty-web.** Apply the intent (§6). |
| D5 | New task's Run and Attach chips. | **Ship Run** (start a run command with the task). **Hide Attach** (`@file` context is still deferred). |
| D6 | Polish muted `#6E6E78` is 3.9:1 on bg, below AA for 12px text. | **Use `#6E6E78` exactly**, per the design owner. This is a known AA shortfall for small muted text, recorded here so it isn't "fixed" back by accident. |
| D7 | Light theme: Polish only defines dark. | Apply the same structural rules to light; keep the A-SystemLight colours. |
| D8 | Composer send key. | **⌘↵ sends**, Enter adds a newline (as drawn). |

## 3. Global rules (A-Polish) and what changes in code

### 3.1 Tokens (`src/index.css`, dark)

The values change and the names stay, as before.

| Role | Polish | Token(s) |
|---|---|---|
| bg | `#0C0C0E` | `--color-bg-base`, `--color-bg-sidebar` (sidebar/inspector are bg now, no tint) |
| inset | `#101013` | `--color-bg-input`, code/diff blocks, activity box |
| surface | `#141417` | `--color-bg-surface`, cards, composer, dialogs (`--color-bg-sheet`) |
| raised | `#1A1A1F` | `--color-bg-elevated`, selected row, secondary button, popovers |
| hover | `#26262C` | `--color-bg-hover` (+1 step), selected segment |
| hairline | `#1F1F24` / `#1A1A1F` | `--color-border-subtle` (structural dividers `#1A1A1F`; floating rings `#1F1F24`) |
| chip border | `#26262C` | `--color-border-default` (only on property chips) |
| text / text-2 / muted | `#ECECEE` / `#A3A3AD` / `#6E6E78` (D6) | `--color-text-primary/secondary/muted` |
| faint (decorative) | `#3A3A42`–`#4A4A54` | `--color-text-faint` |
| status | running `#4F8CFF` · needs you `#F5B548` · **review `#A78BFA`** (new) · done `#3DCF8E` · danger `#F06B6B` | `--color-status-*`; add `--color-status-review` |
| accent | `#E0674A` | unchanged; **actions only** |

Terminal background stays `#000000`; changing it breaks reflow and theme switching. The pane around it gets the bg tone.

### 3.2 The ten rules → code changes

1. **Tone before lines.** Remove every 1px border except three structural dividers: the title bar bottom, the sidebar right edge and the inspector left edge. Inspector sections, the Review/Changes panes and cards separate by spacing or tone. Cards use `box-shadow: 0 0 0 1px #1A1A1F`, not a border.
2. **No boxed secondary buttons.** `Button` gets three looks:
   - secondary = raised fill with no border;
   - ghost = text-2 on transparent, hover raised;
   - destructive = red text, ghost.

   One filled accent primary per screen. Today's "Stop" (red outline) becomes ghost, with destructive styling only in its confirm. "Review diff" and "Filter" become ghost.
3. **Sentence-case labels, 12px, muted.** Remove `uppercase`/`tracking` everywhere: the `group-header` utility, `GroupHeader`, settings section titles, inspector headings, "TASK", "CHANGES", "RUN COMMANDS", "REPOSITORIES" and "WORKSPACES".
4. **No counts in the sidebar.** Remove "Tasks 2", the filter chips (All / Running 1 / Review 1) and the repo counts. Counts stay only on board column headers, muted.
5. **One line per task row.** Rows are 32px: dot · name · agent monogram. Branch, timer and diff stats move off the row; the title bar and inspector already show them.
6. **Mono only for code, paths and branches.** Timers, counts, "119d", "finished 18m ago" and diff counts in prose move to Inter with `tabular-nums`. The `+46 −1` diff stat stays mono; the design keeps it mono as a code-ish value.
7. **Properties as chips.** New task becomes a title, a prompt and one chip row (§4.3).
8. **Tabs are underlines.** Pane tabs (agent / run / Changes / Files / Notes) show a 2px text-colour underline when active, with no box and no notch. The same applies to settings and segmented "Board/List" stays a segmented control (as drawn).
9. **Type.** Inter with `font-feature-settings: "cv11","ss01","ss03"`, `letter-spacing: -0.005em`, base 13px / 1.45. Titles are weight 500, and 600 only at ≥17px.
10. **Shadows replace borders on floating things.** Dialogs, popovers, menus and the composer use `0 0 0 1px #1F1F24, 0 24px 64px rgba(0,0,0,.55)`; the composer uses `0 8px 24px rgba(0,0,0,.25)`. Nothing inline casts a shadow.

### 3.3 Components (A-Polish recap)

- **Buttons:** 28px high, radius 6. Hover = +1 surface step. Press = `scale(.98)` over 120ms.
- **Property chip:** 26px, 1px `#26262C` border. It's the one place a border survives, because it signals "editable value". It has an icon, a value and a caret, and opens a popover.
- **Input:** inset bg, `0 0 0 1px hairline` ring; focus = `0 0 0 1px accent, 0 0 0 4px accent/14%`.
- **Card:** surface + hairline ring. Hover → raised. Selected = a background step, **never** a coloured outline. That replaces today's accent-outlined selected sidebar row.

## 4. Screen by screen

### 4.1 Title bar (Main, A-Workspace)

| Design | Today | Change |
|---|---|---|
| Repo button: 16px mark + name + caret, no box | Boxed "All repositories" / "phasr" pill | Ghost button, no border |
| In a task: `repo / ● task name` (dot with 3px status glow) + branch in mono muted, with no base or arrow chip | Breadcrumb `› ● add-feature [phasr/add-feature ← main]` boxed chip | Slash separator, glow dot, plain mono branch; base moves to the inspector |
| Right: nav "Board" (filled raised when active), then 28px icon buttons for search, bell and settings, then a 24px avatar | Wide search field "Search tasks, files, commands… ⌘K", boxed bell/settings | **Search becomes an icon button** (⌘K tooltip); icons are borderless |

### 4.2 Sidebar (Main, A-Workspace)

- **Header** (44px): "Tasks" at weight 500, then the collapse icon and the + icon (ghost; + is text-2 and not an accent fill).
- **Groups:**
  - Order: **Needs you · Running · Review · Done**, each with a 12px muted sentence-case header 26px high, 18px between groups.
  - Today the order is Running / Needs review / Failed / Done, under uppercase headers.
  - Failed tasks sit in "Needs you" with a red dot. They need action; the board does the same.
- **Row:**
  - 32px: 6px status dot · name (ellipsis) · 14px agent monogram.
  - Done rows: a green check instead of the dot, with the name muted.
  - Active row = raised background + weight 500.
  - No second line, no timer, no diff.
- **Footer:**
  - On the board, "Repositories" with 32px rows (mark + name) and a ghost "+ Add repository".
  - In a task, one line: branch icon · `local · main` · `clean` / `3 changed`.

### 4.3 New task (A-NewTask)

The dialog is 640px wide, with a surface background, radius 12 and the floating shadow. It has no header divider and no footer divider.

- **Header:** a breadcrumb chip `[■ my-project] › New task`, plus close ×.
- **Body:** no boxes.
  - The **task name** is an input styled as a 17px weight-500 title. Its placeholder comes from the prompt, and once the user edits it the name stays fixed.
  - The **prompt** is a borderless textarea (13.5px, text-2, 5 rows) with no visible label; the label is screen-reader only.
- **Chip row:**
  - `[Claude ▾]`: a popover listing every agent with its version, and "Install…" for missing ones.
  - `[⎇ main ▾]`: a popover holding the existing branch search.
  - `[📁 Worktree ▾]`
  - `[🛡 Ask for shell ▾]`
  - `[▶ dev ▾]`: a run command to start with the task, or none (D5).
  - (`[Attach]` stays hidden, per D5.)
  - Each popover follows the popover motion in §5.
- **Footer:**
  - Left: the branch that will be created (`phasr/fix-login-redirect`, mono, muted) and the "Show commands" text link, which expands the plan inline.
  - Right: ghost **Cancel** and primary **Start task ⌘↵**.
  - "Save as draft" moves into the Start split button's menu, or ⌘⇧↵.
  - The notify toggle moves into the permissions popover, as "Notify me when it needs you".
- This replaces the layout shipped in `629a0d5`: two chip rows, the agent radio chips and the bell icon.

### 4.4 Board (Main)

- **Header (44px):**
  - "Board · All repositories" at 13px; the task and agent totals are removed.
  - Board/List segmented control; ghost **Filter**; primary **New task**, with no kbd chip in the button and ⌘N in the tooltip.
- **Columns:** four, in order **Queued · Needs you · Running · Review**.
  - Each header is 28px: 6px dot · name · muted count.
  - "Needs you" is its own column; today it's folded into Running. Review is violet.
  - **Done is not a column.** Under Review sits a muted line "✓ 2 merged today · Show"; Show opens the List view filtered to done.
  - **Failed** has no column of its own. It appears in Needs you with a red dot and a "Failed — open" line, as on A-States.
- **Card:** surface + hairline ring, radius 8, padding 12×14.
  - Title: weight 500, no repo line on top. The repo moves to the footer on Queued cards only.
  - Middle, by lane:
    - Needs you: an inset approval block (text "Wants to run `pnpm install`", **Allow** filled light + **Deny** ghost).
    - Running: an inset mono activity box with the last two lines.
    - Review: `✓ checks · 7 files · +212 −48`.
    - Queued: none.
  - Footer: 14px monogram + agent name, then right-aligned waiting / elapsed / "18m ago" in Inter, with diff stats on Running.
- **"+ Queue a task":** a ghost text row under Queued; today it's a dashed box.

### 4.5 Task session (A-Workspace)

- **Pane tab bar (44px):**
  - Underline tabs: `[C Claude]` `[● dev :3000]` `Changes +46 −1` `Files` `+`.
  - Right side, all ghost: **Open in ▾**, **Stop** (ghost, confirm on click) and an inspector-toggle icon.
  - "Run ▾" moves into the `+` menu and the inspector's Run section, and the "…" menu folds into Open in / the `+` menu. Today the bar has Run, Open in, a red Stop and "…".
- **Main:** the terminal on bg with 20/24px padding (D3).
- **Composer:**
  - One surface, radius 10, floating shadow, no border.
  - A single-line input that grows; the placeholder is "Reply to Claude…".
  - Chips are filled raised (Continue / Run the tests).
  - Right side: muted "⌘↵ send" and a 26px accent send button.
  - **Send = ⌘↵**, Enter = newline. That matches the design but changes today's behaviour, which sends on Enter.
- **Inspector (280px):**
  - Bg, left divider only, sections separated by 22px with no headers boxed.
  - Key/value grid with 72px keys: Agent (with model), Base, Started (`10:38 · 4m 12s`), Usage, Permissions.
  - **Changes:** a heading with the diff stat, mono `M`/`A` rows, and a "Review changes →" text link (today it's a boxed "Review diff" button).
  - **Run:** 30px rows (dot · name · mono command); the running row gets a surface background.
  - **Notes:** the last note as text, then "Add note…" as a muted text link (today it's a dashed box).
  - Remove: the Branch row (it's in the title bar), the Worktree row (moves to Open in), and the "Sync" box. Sync stays as a text action next to Base when behind.

### 4.6 Other screens (layouts unchanged, Polish rules applied)

These screens keep their layouts and get the token, label, border and button changes from §3:
- Review / Changes (`A-Review`)
- Files editor (`A-Editor`)
- Settings sheet (`A-Settings`, `A-SettingsPages`)
- Palette (`A-Palette`)
- First run (`A-FirstRun`)
- Empty repo (`A-EmptyRepo`)
- Needs-you states (`A-States`)
- Compact (`A-Compact`)

The concrete changes:
- uppercase section titles become sentence case;
- boxed secondary buttons become ghost;
- the inspector-style sections lose their dividers;
- the selected state becomes a background step.

## 5. Motion

| What | Spec | Today |
|---|---|---|
| Durations | 120ms hover/press · 160ms panels and popovers · 200ms dialogs and route changes · nothing over 240 | 100/150/160/200 mixed, one 700ms; `--ease-glass` = `cubic-bezier(.16,1,.3,1)` |
| Easing | enter `cubic-bezier(.2,.8,.2,1)`, exit `ease-in` 100ms, no spring | single overshoot-free "glass" curve for both |
| Properties | **transform and opacity only** | `transition-[width]` on TaskSidebar and Inspector; `transition-all` in 3 places |
| Dialog | opacity 0→1 + scale .98→1 over 200ms; backdrop opacity only; exit 100ms | `modal-in` keyframes (check values) |
| Popover / menu | opacity + translateY(-4→0) over 160ms, origin at the trigger; exit 80ms | menus reuse `modal-in` over 120ms |
| Sidebar / inspector collapse | translateX over 160ms inside a clipped container; the icon rail cross-fades in after a 60ms delay; `will-change: transform` only while animating | width tween over 200ms |
| Rows | hover = background only, no transform | ok |
| Reduced motion | all transitions 0ms, opacity only | partial (`index.css` has two blocks; components use `motion-reduce` sporadically) |

New tokens: `--dur-1: 120ms; --dur-2: 160ms; --dur-3: 200ms; --ease-out: cubic-bezier(.2,.8,.2,1); --ease-in: cubic-bezier(.4,0,1,1)`. A single global `prefers-reduced-motion` rule sets every `--dur-*` to 0.

## 6. Performance ("buttery smooth")

### 6.1 Findings in the current build

1. **Panel toggles reflow the terminal on every frame.** `TaskSidebar.tsx:99` and `Inspector.tsx:127` animate `width` over 200ms. The terminal's `ResizeObserver` (`Terminal.tsx:326`) calls `fitAnchored()` on each tick, so a toggle runs about 12 terminal re-wraps plus layout. This is the "laggy" feeling, and it matches the design's 80% note about the terminal.
2. **No list virtualisation.** The sidebar, board and List view render every task. That's fine at today's sizes, but the design asks for virtualisation over 200 rows.
3. Board/sidebar per-second re-renders are already fixed in #37: memoised rows and leaf clocks.
4. The task-view bundle (984 KB first paint) and fonts are already fixed in #37.

### 6.2 Requirements

- **P1 — panel animation doesn't touch the terminal.**
  - The sidebar and inspector animate with `transform` inside an `overflow:hidden` wrapper. The centre column's final width is applied **once**, at the transition start (instant) or the end, not interpolated.
  - The terminal suspends `fit` while a `data-animating` flag is set on the shell, and refits once on `transitionend`.
- **P2 — terminal resize at most once per animation frame.** Coalesce `ResizeObserver` callbacks into a single rAF.
- **P3 — terminal output batched per frame.** Verify the ghostty-web write path coalesces PTY chunks per rAF; if not, add a per-surface queue that is flushed in rAF.
- **P4 — agent-state updates ≤ 30 Hz into the store.** Coalesce the `task-agent-state` and `task-usage` events, and make sure no sidebar row re-renders for another task's events.
- **P5 — virtualise** the sidebar groups, board columns and List view above 200 rows, using `@tanstack/react-virtual` (small, headless).
- **P6 — no `backdrop-filter` anywhere.** Already true; add a lint check. The window stays non-transparent.

### 6.3 Acceptance (measured in the e2e harness)

- **Sidebar and inspector toggles:** 0 terminal `fit` calls during the transition and exactly 1 after. No frame over 16.7ms in a Performance trace at 1440×900 with a 5k-line scrollback.
- **Dialog open, popover open, route change:** no long task over 50ms; the first frame of the animation lands within 1 frame of input.
- **500 fake tasks:** sidebar scroll at 60fps, and board render under 50ms.
- **Reduced motion:** no transform animations at all.

## 7. Out of scope (unchanged deviations)

- Agent transcript view (D3).
- Automations (D2).
- Split panes, Timeline, `@issue`, editor blame/format.
- Usage for Gemini, Copilot and OpenCode.

## 8. Plan

Each step is reviewable and leaves the app working, and each lands with screenshots next to the matching artboard. Steps 1–4 can go in parallel once tokens land.

1. **Tokens and primitives:**
   - `index.css` values (§3.1), plus the motion tokens and reduced-motion block;
   - `Button` looks, `Chip`, `Input` ring, card ring;
   - the `group-header` utility goes sentence case;
   - remove `uppercase` app-wide.
2. **Shell:** title bar (§4.1), sidebar (§4.2), status bar removal (D1), and the transform-based collapse (P1, P2).
3. **Board** (§4.4): the four columns, the Done summary line, and cards per lane.
4. **Task session** (§4.5): underline tabs, the composer (⌘↵ send), and the inspector.
5. **New task** (§4.3): title + prompt + chip row with popovers, plus the Run chip (D5).
6. **Remaining screens** (§4.6) under the global rules.
7. **Performance:** P3, P4 and P5, plus the acceptance traces (§6.3).

### Verification for every step
- `pnpm typecheck`, `pnpm test`, `cargo test` (if backend is touched);
- the e2e suite, updating selectors where the structure changed;
- a side-by-side screenshot per artboard at 1440×900 (dark) and 1280×800 (compact).
