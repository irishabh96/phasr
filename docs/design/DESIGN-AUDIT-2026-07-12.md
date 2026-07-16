# Phasr Full-App Design Audit — Round 2 (2026-07-12)

**Method:** 6 parallel `product-designer` (CRITIQUE-mode) agents, one per UI area, each
grounded in `src/index.css` tokens and sibling components, with **every suspect
contrast pair computed** via `.claude/skills/design-system/scripts/check-contrast.mjs`
in **both** themes. Findings reconciled against the existing `ui-audit` tracker —
tagged `[NEW]`, `[OVERLAP: <ID>]`, or `[FIXED: <ID>]`.

**Overall verdict: ⚠️ Ship with fixes.** The architecture, dark theme, and craft
(terminal persistence, confirm dialogs, humanized conflict copy) are genuinely
strong and *intentional* — no AI-slop, no gratuitous decoration. But there is one
dominant, systemic defect class that dwarfs everything else:

---

## 🟥 THE HEADLINE — Light theme is broken at the token/primitive level

The color tokens were tuned for **dark** and never re-verified in **light**. Because
the failures live in shared tokens (`GlassButton`, `--color-accent-*`,
`--color-text-muted`), a handful of one-line fixes clear **dozens** of surfaces at
once. All ratios below are computed.

| # | Root cause (token/primitive) | Ratio | Where it manifests | Fix |
|---|---|---|---|---|
| **T1** | `GlassButton` **primary**: `text-inverse`(→#fff light) on `accent-500` `#f78166` — `GlassButton.tsx:23` | **2.53:1** (light) FAIL | **Every** primary CTA: Merge, Save, Initialize, Create, Start, Sync, changes-count badge, active repo avatar | Light override: primary fill → `accent-700` `#d4583a` (white ≈4.6:1) **or** primary text → dark ink. Add `--color-accent-onfill`. |
| **T2** | `GlassButton` **danger**: `text-white` on `--color-danger` `#ff7b72` — `GlassButton.tsx:50` | **2.52:1** (dark) FAIL | **Every** danger CTA — incl. "Delete workspace" (deletes branch+worktree+commits) | Dark: darker danger fill (`#b62324`-class) under white, or a `--color-danger-solid` token |
| **T3** | `--color-accent-400` used as **foreground** — doesn't theme-flip like `--color-accent-text` does | **1.73–2.04:1** (light) FAIL | Sidebar "Add repo" +, active TabIcon, coral icons | Swap `accent-400` → `--color-accent-text` (flips to `accent-700` in light, ~4.0:1) |
| **T4** | `--color-text-muted` (light `#6e7781`) tuned for **pure white only** | **4.14–4.36:1** (light) FAIL | Placeholders, help text, branch labels, line numbers, toast code, terminal error `pre` — on `#f4f4f5`/`#fafafb`/`#f4f5f7` | Re-tune light muted → ≈`#5c636b`, **or** move genuine help text to `--color-text-secondary` |
| **T5** | Diff `+/−` markers, line numbers, `+N` count on tinted rows (light) — `DiffView.tsx:483`, `DiffCard.tsx:362` | **2.82–3.89:1** (light) FAIL | Every diff in light theme | New `--diff-add-fg`/`--diff-remove-fg` (~`#0f7a34`/`#b91c1c`), raise row tint 14%→18% |

**T1 and T2 are the two single highest-value fixes in this entire audit** — two lines
in `GlassButton.tsx`, resolving AA on every button in the app. **Escalate T1–T5 to
System Architect** (they touch shared primitives + `[data-theme="light"]` tokens).

---

## 🔧 Systemic themes (fix once → resolve many) — deduped across all 6 areas

1. **Light-theme token contrast (T1–T5 above)** — the dominant issue. Extends
   existing cross-cutting theme #1 (muted-AA) to accent fills, accent-400 fg, and
   the diff palette.
2. **Missing `focus-visible` on hand-rolled buttons** — sidebar icon buttons, diff
   controls (chevron/path/copy/IconButton), tiles/cards/Browse/Back, OAuth, tab
   close. Only `GlassButton`-based controls are safe. → one shared focus-ring
   utility / `GlassIconButton`. [OVERLAP: cross-cutting #2, C13, D6, L2, A2]
3. **`shadow-xl` reintroduced against the flat direction** — `TerminalStartError`,
   `DesktopSignIn` card, `AppToaster`. Tokens collapse `--shadow-*` to `none` on
   purpose. → separate with borders / glass. [NEW]
4. **Off-glass, under-designed feedback** — toasts use the *input* bg token, a raw
   `shadow-xl`, no motion, color-only intent; terminals split status across a
   polished React overlay vs. raw ANSI lines. → one `glass-panel` toast + one
   `TerminalStatus` surface. [OVERLAP: K1, K5, WS-C2/C5]
5. **Error is the systematically dropped state** — happy path + loading usually
   exist; **error frequently falls through to the wrong state**: AppSidebar (all 3
   states blank), `$workspaceId` detail error → *infinite spinner*, Terminal
   `loadLog` failure → raw-ANSI dead-end. → shared `<PanelState kind=…>`. [NEW + census]
6. **No `prefers-reduced-motion` anywhere** — `modal-in`, `pulse-dot`, sidebar
   width transition all animate unconditionally. → one global reduced-motion rule. [NEW]
7. **Dialog-primitive drift** — 4 dialogs, 4 implementations (z-index 150/180,
   top 18/28/30vh, header h-11/h-12, duration 220/200/180, `Dialog.Description` in
   2 of 4, close not `Dialog.Close`, 2 hand-rolled non-Radix). → one shared Radix
   `<Dialog>` shell in `src/components/ui/`. [OVERLAP: B1–B5]
8. **Off-token magic numbers** — durations `150/220/100ms` (token: `--duration-glass`
   180), radii `8px`/`rounded-lg`/`14px` literals, sizes `10.5/12.5px` (base 13),
   inline terminal padding `10/8/2/16`. Route through tokens. [OVERLAP: C15, G3/G4]
9. **Sub-32px hit targets** — sidebar 24px, tab close 20px, dialog close 28px, diff
   controls 24/28px, toast dismiss 24px. Pad interactive box to ≥32. [NEW/systemic]
10. **Color-only status** — diff edge bar, StatusDot, toast intent. Pair color with
    text/icon everywhere. [OVERLAP: A6, GIT-H1]
11. **Native primitives break the glass look** — `window.confirm` (run-cmd delete),
    native `title=` tooltips alongside `GlassTooltip`. [OVERLAP: J1, A2]
12. **Non-semantic controls** — inner tabs (no `role=tab`/tablist), actions menu
    (no `role=menu`), sync strategy radios. [OVERLAP: B3, WS-E1/E4]

---

## Area 1 — Navigation & Chrome
`AppSidebar · TitleBar · WorkspaceInnerTabBar · BranchChip`

**🔴 Blocking**
- Active repo avatar initial invisible in light — `AppSidebar.tsx:150` (white on coral 2.53:1). [NEW → T1]
- Coral icons via `accent-400` vanish in light — `AppSidebar.tsx:336,356`, `WorkspaceInnerTabBar.tsx:142` (1.73–2.04:1). [NEW → T3]
- Sidebar icon-buttons have no focus ring — `AppSidebar.tsx:179-205,331-369`. [OVERLAP: C13]
- Sidebar nav has no loading/error/empty state — `AppSidebar.tsx:70,231`. [OVERLAP: C8+C9]

**🟡 Should-fix**
- Active workspace row == hover — `AppSidebar.tsx:285`. [OVERLAP: C4]
- Three different "active" encodings → `--color-bg-selected` token — repo/workspace/tab. [NEW]
- BranchChip ahead/behind fail AA light — `BranchChip.tsx:51,54` (4.0 / 3.19:1). [OVERLAP: GIT-E1 + NEW behind]
- Sidebar branch code muted fails AA on `#f4f5f7` — `AppSidebar.tsx:307` (4.17:1). [OVERLAP: C7 light-regression → T4]
- Detached HEAD indistinguishable — `BranchChip.tsx:24` (→ `GitCommit` icon + aria). [OVERLAP: GIT-E3/WS-F1]
- Workspace rows: actions right-click-only — `AppSidebar.tsx:274` (→ hover ⋯). [OVERLAP: C3]
- Missing landmark labels — `AppSidebar.tsx:44,69`. [OVERLAP: C11]
- Inner tabs no tab semantics — `WorkspaceInnerTabBar.tsx:40,104` (role=tablist/tab). [OVERLAP: B3]
- Truncated tab titles no tooltip — `WorkspaceInnerTabBar.tsx:120`. [OVERLAP: B4]
- TitleBar breadcrumb dead code — `TitleBar.tsx:46` + `_app.tsx:162`. [OVERLAP: B1]
- Profile/session read non-reactively — `TitleBar.tsx:31`. [OVERLAP: B4]
- Account dropdown scales from center not anchor — `TitleBar.tsx:94` (→ `origin-top-right`). [OVERLAP: B5]
- Initials break on emoji/non-BMP — `AppSidebar.tsx:105`, `TitleBar.tsx:140` (`[...name][0]`). [OVERLAP: C14]
- StatusDot info 2.32:1 on light sidebar — `AppSidebar.tsx:291`. [NEW]

**🟢 Polish:** hardcoded timings/off-scale sizes (`12.5/10.5px`), sub-32 hit targets, BranchChip no loading skeleton (layout shift), one-off chip surface, repo-row ring uses border-strong not accent, hidden scrollbar on tab overflow (add fade-mask), magic `52px` rail width. [mostly OVERLAP: C15]

**✅ Confirmed fixed:** C1/C2/C5 (keyboard rows), C6 (rail names), C7 (dark), B2/B3 (search aria/shortcut), WS-A1/GIT-E2 (truncate), WS-B1/B2 (pinned +, tab tint).

---

## Area 2 — Workspace View & Terminals
`$workspaceId route · RunCommandsSection · SessionTerminalTab · Terminal · RunCommandTerminal`

**🔴 Blocking**
- Changes-count badge white-on-coral fails AA light — `$workspaceId.tsx:203` (2.53:1). [NEW → T1]
- `TerminalStartError` reintroduces `shadow-xl` + off-scale radius/blur — `TerminalStartError.tsx:17`. [NEW → systemic #3]
- Start-failure overlay invisible to keyboard+SR — `TerminalStartError.tsx:15` (no `role="alert"`, Retry not focused). [NEW]

**🟡 Should-fix**
- "starting…" feedback asymmetric + low-contrast ANSI dim — main/session terminals show blank void; `RunCommandTerminal.tsx:92` dim ≈3.56:1 light. [OVERLAP: C2]
- Exit state = dim dead line, 3 copy variants, no restart — `Terminal.tsx:182`, `SessionTerminalTab.tsx:176`, `RunCommandTerminal.tsx:82`. [OVERLAP: C5]
- More raw-ANSI dead-ends bypass overlay — `Terminal.tsx:218,163,238` (log-load, input error). [NEW → systemic #4/#5]
- `Run` filled-coral on every row (accent overuse) — `RunCommandsSection.tsx:196`. [NEW → accent-scarcity]
- Run-commands empty state missing — `RunCommandsSection.tsx:153`. [NEW]
- Edit "Save" no pending/disabled — `RunCommandsSection.tsx:187`. [OVERLAP: J2]
- Native `window.confirm` delete — `RunCommandsSection.tsx:237`. [OVERLAP: D5/J1]
- Native `title` vs GlassTooltip — `$workspaceId.tsx:191`, `RunCommandsSection.tsx:201`. [OVERLAP: A2]
- ChangesToggle h-7-in-40px + hardcoded ⌘J — `$workspaceId.tsx:191-193`. [OVERLAP: A3/A4]
- Off-token padding/radius/duration (10/8/2/16, `rounded-[14px]`, `duration-[220ms]`). [NEW → systemic #8]
- Live theme switch doesn't re-theme mounted terminals — `xterm.ts:58`. [NEW — verify in-app]
- Error-detail/loading text fail AA light — `TerminalStartError.tsx:28` (4.36:1), `$workspaceId.tsx:95`. [NEW → T4]

**🟢 Polish:** run-cmd name no truncate, terminal focus affordance mouse-only, count badge no `99+` cap, mixed border tokens, aria-hidden during collapse.

**✅ Confirmed fixed:** WS-C1 (TerminalStartError+Retry, modulo a11y/shadow above), C3 (padding now symmetric), WS-D1 (pinned run-cmds+⌘1–9), WS-E2 (Open-PR toast).

---

## Area 3 — Diff & Changes
`ChangesPanel · diff/DiffCard · diff/DiffList (+ DiffView)`

**🔴 Blocking**
- Light diff palette fails AA — markers/line-numbers/counts 2.82–3.89:1 on tinted rows. [NEW → T5]
- No focus-visible on any diff control — `DiffCard.tsx:162-193,320-335`. [NEW → systemic #2] *(highest-value single fix in area)*
- Split/Inline toggle has no visible control in Changes panel (only `⌘\`) — `DiffCard.tsx:278` + `DiffList` has no toolbar. [OVERLAP: GIT-A3 — strengthen]
- File status color-only; `noHeader` drops status pills + rename old→new — `DiffCard.tsx:149,503`. [OVERLAP: GIT-C3 + a11y]

**🟡 Should-fix**
- Each `DiffList` registers its own global `⌘\` + writes localStorage (4× in panel) → lift `mode` to `ChangesPanel` — `DiffList.tsx:78,124`. [NEW] *(real bug)*
- Hit targets 24/28px — `DiffCard.tsx:167,186,327`. [NEW]
- Two toggle controls, only chevron has `aria-expanded` — `DiffCard.tsx:162`. [OVERLAP: GIT-C8]
- `break-all` shreds code tokens — `DiffView.tsx:379`. [OVERLAP: GIT-C1]
- Line-number col clips 4-digit — `DiffView.tsx:363`. [OVERLAP: GIT-C2]
- Nested scroll region (600px cap inside scrolling panel) — `DiffCard.tsx:279`. [OVERLAP: GIT-C7]
- Errors raw not humanized — `ChangesPanel.tsx:203,375`. [OVERLAP: GIT-A2/L3]
- Commit button no disabled reason — `ChangesPanel.tsx:331`. [OVERLAP: GIT-B6]
- Textarea stays expanded after commit — `ChangesPanel.tsx:152`. [OVERLAP: GIT-B7]
- "Fade" success never fades — `ChangesPanel.tsx:384`. [OVERLAP: GIT-B8]
- Binary status color inconsistent (edge=info, badge=muted) — `DiffCard.tsx:511`. [OVERLAP: GIT-H1]
- Discard icon reads as "undo" — `DiffCard.tsx:250` (→ `Trash2` for untracked). [OVERLAP: GIT-G2]
- CountsBadge no accessible label — `DiffCard.tsx:338`. [OVERLAP: GIT-C9]
- Expand/collapse no motion, layout shift — `DiffCard.tsx:267`. [NEW]
- Double clipboard write on copy-path — `DiffCard.tsx:130` + `ChangesPanel.tsx:114`. [NEW]

**🟢 Polish:** `−` vs `-` glyph inconsistency, 10.5px section headers, section-title not aligned to card inset, chevron no `aria-controls`, conflict-resolve icons undifferentiated (tone the destructive pick), redundant `cursor-pointer`.

**✅ Confirmed fixed:** GIT-A1 (status error), GIT-B1 (loading/error badges), GIT-B3/B4 (conflict labels + confirm), GIT-G1 (untracked discard copy). *Confirm dialogs + MergeBanner are the strongest craft in the app.*

---

## Area 4 — Dialogs & Modals
`MergeToMainDialog · RenameWorkspaceModal · GitInitConfirmModal · WorkspaceActionsMenu`

**🔴 Blocking**
- Danger "Delete workspace" fails AA dark — `WorkspaceActionsMenu.tsx:325` via `GlassButton.tsx:50` (2.52:1). [NEW → T2]
- Primary CTA fails AA light (Merge/Save/Initialize) — `GlassButton.tsx:22` (2.53:1). [NEW → T1]
- Hand-rolled Confirm/Error dialogs — no focus trap, no roles, ErrorDialog no Esc — `WorkspaceActionsMenu.tsx:289,338`. [OVERLAP: SHELL-D1/FORMS-B1]
- GitInit no try/catch → silent failure / frozen dialog — `GitInitConfirmModal.tsx:27`. [OVERLAP: FORMS-F1]

**🟡 Should-fix**
- WorkspaceActionsMenu raw `String(err)` — `:99,121,152` (→ humanizeError). [NEW]
- Merge button stays enabled after conflict — `MergeToMainDialog.tsx:252`. [OVERLAP: GIT-D5 — **still open**]
- Merge conflict copy-only, no "Open terminal" action — `MergeToMainDialog.tsx:94`. [GIT-D4 copy fixed, affordance residual]
- Overlay `modal-in` scale → edge-gap flash → fade-only keyframe — all 3 Radix dialogs. [OVERLAP: FORMS-B2]
- No reduced-motion fallback — global. [NEW → systemic #6]
- No exit animation — all 4. [OVERLAP: FORMS-B3]
- Initial focus lands on Close (X) — `MergeToMainDialog.tsx:117`, `GitInitConfirmModal.tsx:59`. [OVERLAP: FORMS-L4]
- Rename: no `Dialog.Description`, input no accessible name — `RenameWorkspaceModal.tsx:26,82`. [OVERLAP: FORMS-B1]
- Rename autofocus doesn't select text — `RenameWorkspaceModal.tsx:86`. [OVERLAP: FORMS-C5]
- Close button 28px + not `Dialog.Close` — all 3. [OVERLAP: FORMS-B5]
- Header height / vertical anchor drift — h-11/h-12, 18/28/30vh. [OVERLAP: FORMS-B4]
- Hand-rolled dialog header/body px-5 vs footer px-4 — `WorkspaceActionsMenu.tsx:313,356`. [NEW]

**🟢 Polish:** GitInit Title Case, ad-hoc durations, actions menu not `role=menu`, `handleDelete` silent gap, Rename/GitInit Cancel not disabled during pending, merge success banner shows alongside form.

**✅ Confirmed fixed (this session):** GIT-D1 (Sync real action), GIT-D2 (Merge strategy radios semantic — SyncButton twin still open), GIT-D3 (success holds 800ms), humanizeError, focus rings, modal-in, max-height+scroll, formatFileList, double-submit guard.

**→ Systemic:** extract a shared Radix `<Dialog>` primitive (systemic #7) — resolves B1–B5 + the hand-rolled a11y holes in one move.

---

## Area 5 — Forms & Onboarding
`NewWorkspaceForm · NewTaskForm · NewProjectPane · CreateFirstWorkspacePane · DesktopSignIn`

**🔴 Blocking**
- OAuth buttons: inline `style` overrides kill both hover states + no focus ring — `DesktopSignIn.tsx:250` (→ `GlassButton variant=outline`). [OVERLAP: I2/A2]
- Sign-in card `shadow-xl` against flat direction — `DesktopSignIn.tsx:193`. [NEW → systemic #3]
- NewProjectPane has no `<form>` → Enter dead in all 3 modes — `NewProjectPane.tsx:157`. [OVERLAP: D1/L1]
- Tiles/cards/Browse/Back no focus-visible — `NewProjectPane.tsx:336,373,168,144`. [OVERLAP: D6/L2]
- Light muted text fails AA on real surfaces — `GlassInput.tsx:8` + forms (4.14–4.36:1). [NEW → T4]
- First-workspace: plain Enter dead, focus lost on step change — `CreateFirstWorkspacePane.tsx:112,166`. [OVERLAP: E2/E1]
- Auth "waiting" strands user (no cancel), errors toast-only — `DesktopSignIn.tsx:221,118`. [OVERLAP: I4/I3]

**🟡 Should-fix**
- Raw `<select>` × 4 diverge from inputs + each other → `GlassSelect` — `NewWorkspaceForm.tsx:83` etc. [OVERLAP: C4]
- NewWorkspaceForm Name field has no label — `NewWorkspaceForm.tsx:73`. [OVERLAP: C2]
- Labels not associated (`htmlFor`/`id`) — `NewTaskForm.tsx:116`, `NewWorkspaceForm.tsx:80`. [OVERLAP: C2]
- No required affordance / no invalid field state — [OVERLAP: C3/A3]
- NewProject error persists across mode switch — `NewProjectPane.tsx:55`. [OVERLAP: D2]
- Double-navigation race on success — `NewProjectPane.tsx:90`. [OVERLAP: D3]
- Clone destination silent — `NewProjectPane.tsx:109` (→ mono path preview). [OVERLAP: D4]
- Default location hidden dotfolder `~/.phasr/projects` — `NewProjectPane.tsx:64`. [OVERLAP: D5]
- isGit optimistically true while loading — `CreateFirstWorkspacePane.tsx:48`. [OVERLAP: E3]
- No Esc→Back on Step 2 — `CreateFirstWorkspacePane.tsx:112`. [OVERLAP: E4]
- Sign-in copy capitalization — `DesktopSignIn.tsx:200`. [OVERLAP: I5]
- NewWorkspaceForm error shoves buttons (no truncate/own row) — `NewWorkspaceForm.tsx:115`. [NEW]
- Two label typographic systems across the forms area. [NEW]

**🟢 Polish:** no `maxLength` on name fields, DesktopSignIn off-token radii/sizes, truncated task error no tooltip, NewProject path/name validation, `border-2` tiles heavier than 1px norm, autofocus first OAuth button.

**✅ Confirmed fixed:** FORMS-C1/L3 (humanizeError in all 5 forms), FORMS-I1 (wordmark currentColor), FORMS-A1 (danger focus ring). *CreateFirstWorkspacePane is the labeling + mono-preview reference.*

---

## Area 6 — Feedback & States
`AppToaster · toast.ts · TerminalStartError` + app-wide state census

**🔴 Blocking**
- Toast intent color-only; light success border 3.0:1 — `AppToaster.tsx:5,22` (add intent icon). [OVERLAP: K5]
- Auto-dismiss no hover/focus pause — action toasts vanish mid-reach — `toast.ts:66`. [OVERLAP: K2]
- Toaster returns `null` when empty → non-persistent live region → SR drops announcements — `AppToaster.tsx:14`. [NEW]
- `$workspaceId` detail fetch error → infinite "Loading…" (no `isError` branch) — `$workspaceId.tsx:93`. [NEW → systemic #5]
- Terminal `loadLog` failure = raw-ANSI dead-end (finished/failed workspaces) — `Terminal.tsx:210`. [NEW → systemic #5]

**🟡 Should-fix**
- `useToasts` cleanup wipes global toast state on any consumer unmount — `toast.ts:73`. [OVERLAP: K4] *(correctness bug)*
- Toasts off-glass + `shadow-xl` (uses input bg token) — `AppToaster.tsx:22` (→ `glass-panel`). [OVERLAP: K1]
- Toasts no enter/exit motion — `AppToaster.tsx:18`. [OVERLAP: K1]
- Toast action = faint chip not CTA — `AppToaster.tsx:38` (→ `GlassButton`). [OVERLAP: K3]
- Toast `code` fails AA light — `AppToaster.tsx:32` (4.14:1). [NEW → T4]
- `TerminalStartError` off-system + a11y (role/focus/pending/pre-contrast) — `TerminalStartError.tsx:16`. [NEW]
- Sidebar zero-repo empty + loading/error missing — `AppSidebar.tsx:70`. [OVERLAP: C8+C9]
- Main terminal no "Starting…" feedback — `Terminal.tsx:174`. [OVERLAP: WS-C2]
- AuthGate loading/error unstyled muted, no retry — `_app.tsx:32`. [OVERLAP: SHELL-A3]

**🟢 Polish:** toast dismiss 24px target, toasts silently drop past 4 (no "+N more"), history/changes/detail loading bare text not skeletons.

### State-coverage census (error is the dropped state)
| Surface | Empty | Loading | Error |
|---|---|---|---|
| AppSidebar | MISSING | MISSING | MISSING [C8/C9] |
| ChangesPanel | present | partial | present [FIXED: GIT-A1] |
| HistoryPanel | present | partial | partial (raw msg) [GIT-F4] |
| InnerTabBar | MISSING in-place [WS-B5] | N/A | N/A |
| Terminal (main) | N/A | MISSING [WS-C2] | partial (start fixed; **loadLog dead-end** [NEW]) |
| DesktopSignIn | N/A | present | partial (toast-only) |
| NewProjectPane | N/A | present | present (humanized) |
| $workspaceId | N/A | partial | **MISSING → infinite spinner** [NEW] |
| _app shell | N/A | partial | partial (muted, no retry) [SHELL-A3] |

---

## 🚦 Suggested fix priority for fe-developer

**Batch 0 — Token/primitive (System Architect first, then fe-developer). Biggest ROI.**
1. **T1** — `GlassButton` primary AA in light (2 lines) → fixes every primary CTA app-wide.
2. **T2** — `GlassButton` danger AA in dark → fixes Delete + all danger buttons.
3. **T3** — stop using `--color-accent-400` as foreground (→ `--color-accent-text`).
4. **T4** — re-tune light `--color-text-muted` (or move help text to `secondary`).
5. **T5** — `--diff-add-fg`/`--diff-remove-fg` + row-tint bump.

**Batch 1 — App-wide a11y (mechanical, high-volume).**
6. Shared focus-ring on all hand-rolled buttons (systemic #2): sidebar, diff, tiles, OAuth, tab close.
7. Global `@media (prefers-reduced-motion)` rule (systemic #6).
8. Remove `shadow-xl` from `TerminalStartError`, `DesktopSignIn`, `AppToaster` (systemic #3).

**Batch 2 — Broken/dead states (correctness).**
9. `$workspaceId` error branch (infinite spinner) + Terminal `loadLog` dead-end.
10. `useToasts` global-wipe + uncleared timers (`toast.ts`).
11. GitInit try/catch + error banner.
12. Merge button disable-after-conflict (GIT-D5).
13. AppSidebar empty/loading/error states.

**Batch 3 — Feedback system.**
14. Toast → `glass-panel` + intent icons + motion + hover-pause + action-as-button (K1/K2/K3/K5).
15. `TerminalStartError`/exit → shared `TerminalStatus` (role/focus/pending) + terminal "Starting…".

**Batch 4 — Shared primitives (refactor).**
16. Extract Radix `<Dialog>` shell (systemic #7) → migrate all 4 dialogs + hand-rolled Confirm/Error.
17. `GlassSelect` primitive → replace 4 hand-rolled selects.
18. `<PanelState kind=…>` for empty/loading/error.

**Batch 5 — Per-surface polish** — everything tagged 🟡/🟢 above not already covered.

---

## Needs running app (`pnpm tauri dev`) — can't judge statically
- **Light-theme legibility in situ** — verify T1–T5 against the real blurred glass backdrops (solid-color estimates may be slightly optimistic).
- **Terminal states** — blank-void "starting" latency, exited-agent restart, live theme re-theming, ANSI dim real contrast.
- **Diff with real data** — conflicted (combined-diff → may render "No changes"), binary, renamed, 1000+-line files, 600px inner-scroll trap.
- **Motion** — modal edge-flash on overlay scale, reduced-motion honoring, expand/collapse snap, toast enter/exit.
- **Live regions (VoiceOver)** — toast + `TerminalStartError` announcement; the non-persistent-region risk is only observable at runtime.
- **Focus behavior** — dialog initial focus lands on Close; hand-rolled dialogs' focus trap/return; multi-step form focus handoff.
