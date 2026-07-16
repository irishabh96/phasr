# ADR-001: Design-System Foundations (Batch 0 review + shared tokens + Batch 4 primitive contracts)

## Status

Accepted — 2026-07-12

## Context

The full-app design audit (`docs/design/DESIGN-AUDIT-2026-07-12.md`, "Round 2")
found that Phasr's craft is strong but suffers from **token/primitive-level
drift**: light-theme contrast failures in shared primitives, three divergent
"selected row" encodings, ad-hoc `z-index` literals (context menus rendering
_over_ modals), no `prefers-reduced-motion` fallback anywhere, focus rings only
on `GlassButton`-derived controls, and four drifting dialog implementations.

The audit prescribes a batched rollout. **Batch 0** (light/dark AA token fixes)
is already applied to `src/index.css` + `GlassButton.tsx`. This ADR:

1. Ratifies the Batch-0 additions.
2. Adds four shared foundations (`--color-bg-selected`, a `z-index` scale, a
   global reduced-motion rule, a canonical focus-ring token).
3. Fixes the contracts (API only) for the three Batch-4 shared primitives so
   `fe-developer` can implement deterministically.

Tokens are CSS-first in `src/index.css` (Tailwind v4, `@theme` + a
`[data-theme="light"]` override block). The accent palette (`--color-accent-*`)
is **theme-invariant** — coral renders the same in dark and light; only
`--color-accent-text` flips. That invariant drives several decisions below.

---

## Decision 1 — Ratify Batch-0 token additions

Reviewed for design-system consistency and naming. **APPROVED as-is** (they are
contrast-verified; changes kept to zero).

| Token | Value | Naming verdict |
|---|---|---|
| `--color-accent-onfill` | `#010409` (`@theme` only) | ✅ Correct. `-onfill` clearly reads "ink placed ON a coral fill". Living in `@theme` with **no** light override is the right encoding of "coral is theme-invariant, so its ink is too" — mirrors the existing `--color-text-inverse` intent but is scoped to accent fills. |
| `--color-danger-solid` | `#c93c37` dark / `#dc2626` light | ✅ Correct. `-solid` distinguishes the darker **fill-under-white-text** red from the vivid `--color-danger` (used as _foreground_ text). Overriding per-theme is right: dark needs the darker `#c93c37`, light's `--color-danger` (`#dc2626`) already clears 4.5:1 under white so it doubles as the solid fill. |
| `--diff-add-fg` / `--diff-remove-fg` | dark = `var(--color-success)`/`var(--color-danger)`; light = `#0c6e2e`/`#b91c1c` | ✅ Correct. The `-fg` suffix + dark-aliases-to-semantic-token / light-hardcodes pattern is consistent with how the audit split "vivid on dark, darker on tinted-light". |

**One naming note (non-blocking, no change made):** `--color-danger-solid` and
`--color-accent-onfill` sit in slightly different conceptual buckets (one is a
_fill_, one is an _ink_). They read fine together because both are qualified by
suffix. Leave as-is; do not rename — the callers in `GlassButton.tsx` are already
wired and the names are self-documenting.

---

## Decision 2 — `--color-bg-selected`: unify the three "active/selected" encodings

**Problem.** Three divergent treatments for the same semantic ("this row/tab is
the current selection"):

- Repo row — `AppSidebar.tsx:127` → `accent-500 @ 12%`
- Inner tab — `WorkspaceInnerTabBar.tsx:121` → `accent-500 @ 14%`
- Workspace row — `AppSidebar.tsx:282` → `--color-bg-elevated` (identical to its
  own hover, so "active" is invisible — audit C4/T-area-1 blocking-adjacent).

**Decision.** One token, `12%` (the repo-row value; tabs step down from 14%):

```css
--color-bg-selected: color-mix(in oklab, var(--color-accent-500) 12%, transparent);
```

- **`@theme` only, no light override.** `--color-accent-500` is theme-invariant,
  so the same coral composites over the sidebar/tab surface in either theme
  (same rationale as `--color-accent-onfill`).
- **Distinct from `--color-bg-hover` in both themes — by hue, not lightness.**
  `--color-bg-hover` is a _neutral grey_ (`#161b22` dark / `#f1f1f3` light); the
  selected tint is _warm coral_. Even at similar perceived lightness the two are
  unambiguous because they differ in chroma/hue, and "selected" is a persistent
  state while "hover" is transient. Selected rows additionally pair with
  `--color-text-primary` label color, reinforcing the distinction.
- **Translucent on purpose** (mixes with `transparent`) so it layers correctly
  over the glass/sidebar backdrops rather than punching an opaque hole.

`fe-developer` replaces all three literals with `bg-(--color-bg-selected)`.

---

## Decision 3 — `z-index` scale

**Problem.** Ad-hoc literals: dropdowns/context menus at `z-200`, command palette
`z-200`, modal overlay/content `z-180`/`z-190`, hand-rolled confirm/error `z-150`,
toaster `z-1000`. Net bug: a context menu (`200`) renders **over** a modal (`190`).

**Decision.** A single ascending ladder in `@theme`:

```css
--z-dropdown: 1000; /* menus/context-menus/selects anchored in page flow */
--z-sticky:   1100; /* sticky headers / toolbars pinned during scroll        */
--z-overlay:  1200; /* modal & drawer backdrop scrim                          */
--z-modal:    1300; /* modal / dialog content                                */
--z-popover:  1400; /* popovers/menus/selects that must layer OVER a modal    */
--z-toast:    1500; /* toasts / notifications — always on top                 */
```

Layer intent:

- **`--z-dropdown`** — the default for menus in normal page flow. Sits _below_
  modal content, which resolves the flagged bug: a stray context menu can no
  longer paint over a dialog.
- **`--z-sticky`** — sticky in-page chrome (e.g. a pinned toolbar) above content
  but below any overlay.
- **`--z-overlay` / `--z-modal`** — the scrim, then the dialog surface on top.
- **`--z-popover`** — the escape hatch: a `GlassSelect`/menu opened _inside_ a
  dialog needs to beat `--z-modal`, so it uses this tier.
- **`--z-toast`** — highest; toasts must stay visible over everything, including
  an open modal.

Migration note for `fe-developer`: swap literals per surface — dialog overlays
`z-[180]`→`--z-overlay`, dialog content `z-[190]`→`--z-modal`, dropdown/context
menus `z-[200]`→`--z-dropdown` (or `--z-popover` if nested in a modal), palette
`z-[200]`→`--z-modal`, toaster `z-[1000]`→`--z-toast`. Not applied here (this ADR
touches CSS + docs only; component edits are Batch 1+).

---

## Decision 4 — Global `prefers-reduced-motion` fallback

**Problem.** No reduced-motion handling anywhere: `modal-in`, `pulse-dot`, the
sidebar-width transition, toast motion, and hover lifts all animate
unconditionally.

**Decision.** One global rule near the base resets:

```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- Uses **`0.01ms`, not `0`**, so `transitionend`/`animationend` still fire and any
  JS awaiting them resolves (e.g. Radix exit-animation coordination).
- Global by design — every modal/toast/pulse honors it with zero per-component
  wiring. New components inherit the behavior for free.

---

## Decision 5 — Standardize the focus ring

**Decision.** Canonize the pattern `GlassButton` already ships as THE convention
for interactive controls, and expose it as a helper token:

```css
--ring-focus: 0 0 0 2px var(--color-accent-300);
```

Apply to hand-rolled buttons as:

```
focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]
```

- Matches `GlassButton`'s existing ring exactly, so migrated hand-rolled buttons
  look identical to existing ones (consistency over cleverness).
- **Text inputs are deliberately exempt** — `GlassInput` keeps its softer ring
  (`4px @ accent-500 12%` + border color-shift). Two intentional treatments:
  crisp 2px ring for buttons/rows, soft halo for text fields.

**Known follow-up (not fixed here):** `--color-accent-300` (`#ffa88a`) is pale on
near-white light surfaces, so the ring is subtle in light theme. Batch 0 scoped
_text/fill_ AA only; focus-ring contrast is a separate future pass. Documenting
the caveat rather than diverging from the shipped convention now.

`fe-developer` applies `--ring-focus` to: sidebar icon-buttons, diff controls
(chevron/path/copy/IconButton), tiles/cards/Browse/Back, OAuth buttons, tab close
(audit systemic #2).

---

## Decision 6 — Batch-4 shared primitive contracts (API only)

These are **contracts, not implementations**. `fe-developer` builds the
components; the interfaces + token/class + state tables below make that
deterministic.

### 6a. `<Dialog>` shell — `src/components/ui/Dialog.tsx`

Radix (`@radix-ui/react-dialog`) shell that replaces the 4 drifting dialogs
(`MergeToMainDialog`, `RenameWorkspaceModal`, `GitInitConfirmModal`,
`NewWorkspace/NewTask`) + the 2 hand-rolled non-Radix Confirm/Error dialogs in
`WorkspaceActionsMenu`. It fixes the drift catalogued in audit B1–B5: z-index
150/180, top 18/28/30vh, header h-11/h-12, duration 220/200/180,
`Dialog.Description` present in only 2 of 4, close not a `Dialog.Close`.

**Structure (fixed):** `Dialog.Root` → `Dialog.Portal` → `Dialog.Overlay`
(fade-only keyframe, `z-index: var(--z-overlay)`, honors global reduced-motion) →
`Dialog.Content` (`glass-modal`, `modal-in` enter + `data-[state=closed]` exit,
`z-index: var(--z-modal)`, **one** `top` offset for all dialogs,
`onOpenAutoFocus` moves focus to the primary action, not the close X).

**Required slots:** `Dialog.Description` is **required** (a11y — every dialog gets
a description); a 32px `Dialog.Close` (fixes sub-32 hit target + "not a
`Dialog.Close`" a11y hole); header is `h-11` (canonical).

```ts
// A fade-only overlay keyframe (no scale) is used to kill the edge-gap flash
// the current scale-based modal-in produces on the backdrop.
interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title. Rendered in the h-11 header, wired to aria-labelledby. */
  title: React.ReactNode;
  /**
   * REQUIRED. Rendered in a Dialog.Description slot (wired to aria-describedby).
   * Pass a node for rich copy; pass a visually-hidden string when the body is
   * self-describing but a11y still needs a description.
   */
  description: React.ReactNode;
  /** Body content (form, message, strategy rows, …). */
  children: React.ReactNode;
  /** Footer actions, right-aligned (Cancel + primary/danger). Optional. */
  footer?: React.ReactNode;
  /** Content max-width. Default "md" (≈460px); accepts a px/clamp string. */
  size?: "sm" | "md" | "lg" | string;
  /**
   * Element to focus on open, overriding the default (primary action).
   * Radix onOpenAutoFocus target.
   */
  initialFocusRef?: React.RefObject<HTMLElement>;
}
```

**Tokens / classes used:**
`glass-modal` (surface), `--z-overlay` (Overlay), `--z-modal` (Content),
`--color-bg-overlay` (scrim), `--glass-border-hairline` (header/footer rules),
`--radius-modal` (via `glass-modal`), `modal-in` keyframe (enter) + a new
**fade-only** overlay keyframe, header `h-11`, close button 32px
(`--radius-control`), global reduced-motion rule handles motion-reduce.

**States:** `open` (enter: content `modal-in`, overlay fade) · `closed`
(`data-[state=closed]` exit animation, then unmount) · `reduced-motion`
(near-instant via global rule) · focus (trapped by Radix; initial focus =
primary action or `initialFocusRef`; Esc + scrim-click close via `onOpenChange`).

**Consumer shape (Confirm/Error collapse into this):** a thin `<ConfirmDialog>`
and `<ErrorDialog>` may wrap `<Dialog>` with preset `footer` (Cancel + `danger`
confirm) / (single Close) — but they compose the shell, they do **not**
re-implement it.

---

### 6b. `<GlassSelect>` — `src/components/ui/GlassSelect.tsx`

Styled **native `<select>`** (no new dependency — `@radix-ui/react-select` is not
installed, and the native control gives keyboard + a11y for free). Replaces the 4
hand-rolled `<select>`s (`NewWorkspaceForm`, etc.) that drift from `GlassInput`
and from each other.

**Contract:** reuse `GlassInput`'s exact `baseClasses` (same
border/hover/focus/disabled tokens) so a select and an input are visually a
matched set. Add a right-aligned chevron (`lucide-react` `ChevronDown`,
`pointer-events-none`, `--color-text-muted`) and `appearance-none` +
right-padding to clear it.

```ts
interface GlassSelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /**
   * Options may be passed as data OR as <option>/<optgroup> children.
   * When both are given, `options` renders first.
   */
  options?: Array<{
    label: string;
    value: string;
    disabled?: boolean;
  }>;
  /** Optional leading placeholder rendered as a disabled first <option>. */
  placeholder?: string;
}
// Ref-forwarded to the underlying <select> (forwardRef<HTMLSelectElement>).
```

**Tokens / classes used:** `GlassInput` `baseClasses` verbatim —
`--color-bg-input` (@70% mix), `--glass-border-hairline` (border),
`--color-border-strong` (hover border), `--color-accent-500` (focus border) +
`accent-500 @12%` focus halo, `--color-text-primary` (value),
`--color-text-muted` (chevron), `--radius-control` (10px), `--duration-glass`
+ `--ease-glass`. Sizing matches `GlassInput` (`h-9 px-3 text-[13px]`), with
extra right padding for the chevron.

**States:** default · hover (`--color-border-strong` border) · focus-visible
(`--color-accent-500` border + soft halo — inherits input treatment) · disabled
(`opacity-50`, `cursor-not-allowed`) · placeholder-selected (muted value color
when the disabled placeholder option is current).

---

### 6c. `<PanelState kind="loading" | "empty" | "error">` — `src/components/ui/PanelState.tsx`

One primitive to fill the state gaps the audit's census flagged: AppSidebar (all
3 states blank), `$workspaceId` detail (error → infinite spinner), Terminal
`loadLog` failure (raw-ANSI dead-end).

```ts
interface PanelStateProps {
  kind: "loading" | "empty" | "error";

  // --- empty ---
  /** Headline for kind="empty". */
  title?: string;
  /** Supporting sentence under the headline (empty + error). */
  description?: string;
  /** CTA slot for kind="empty" (e.g. an "Add repo" GlassButton). */
  action?: React.ReactNode;
  /** Optional leading icon for kind="empty". */
  icon?: React.ReactNode;

  // --- error ---
  /**
   * Raw error for kind="error". Rendered via humanizeError(); never shown raw.
   */
  error?: unknown;
  /** Retry slot for kind="error" (e.g. a Retry GlassButton wired to refetch). */
  onRetry?: () => void;

  // --- loading ---
  /** Number of skeleton rows for kind="loading". Default 3. */
  rows?: number;

  /** Constrains layout; primitive fills its parent by default. */
  className?: string;
}
```

**Per-kind rendering:**

- **`loading`** → `rows` skeleton bars (pulse via `pulse-dot`-style shimmer or a
  reduced-motion-safe static block; global reduced-motion rule neutralizes the
  animation). Neutral surface tokens only.
- **`empty`** → optional `icon`, `title` headline (`--color-text-primary`),
  `description` support (`--color-text-secondary` — NOT `muted`, per T4 AA),
  then the `action` CTA slot.
- **`error`** → danger headline (`--color-danger`), the message run through
  `humanizeError(error)` (`--color-text-secondary`), then the Retry slot
  (`onRetry` → a `GlassButton variant="outline"`). Container gets
  `role="alert"` so SR announces it (fixes the silent-error a11y holes).

**Tokens / classes used:** `--color-text-primary` / `--color-text-secondary`
(copy — avoid `--color-text-muted` for genuine help text per audit T4),
`--color-danger` (error headline), `humanizeError()` (message), `GlassButton`
(CTA / Retry slots), `--radius-panel`, `--color-border-subtle`, `pulse-dot`
keyframe (loading shimmer), `role="alert"` on error.

**States:** the three `kind`s are mutually exclusive; consumer switches on its
query state (`isLoading` → `loading`, empty data → `empty`, `isError` →
`error`). No internal state.

---

## Consequences

### Positive

- Light-theme AA failures in shared primitives resolved at the token layer (a
  handful of lines clear dozens of surfaces) — Batch 0 ratified.
- One `--color-bg-selected` kills three divergent encodings; selection is now
  hue-distinct from hover app-wide.
- z-index bugs (menu-over-modal) become structurally impossible; new surfaces
  pick a named tier instead of inventing a literal.
- Reduced-motion is honored everywhere with zero per-component cost.
- Focus ring is one token; hand-rolled buttons converge on `GlassButton`'s look.
- Batch-4 primitives have deterministic contracts — `fe-developer` implements
  without re-litigating API.

### Negative / trade-offs

- `--ring-focus` uses `accent-300`, which is subtle on light surfaces; a future
  focus-contrast pass may need to theme it. Accepted to preserve the existing
  convention now (see Decision 5).
- The z-index ladder jumps from the old ~150–1000 range to 1000–1500. Until every
  literal is migrated (Batch 1+), old and new values coexist; migrate the whole
  overlay/dropdown/toast set together to avoid mixed-scale layering.
- `--color-bg-selected` at 12% is intentionally quiet; if in-app testing (audit's
  "needs running app" list) finds it too weak against real blurred backdrops, the
  single knob to turn is the mix percentage — do not re-fork per surface.

## Alternatives considered

1. **Per-theme `--color-bg-selected`** — rejected. `accent-500` is
   theme-invariant, so a light override would duplicate the identical value; a
   single `@theme` def is DRY and matches the `--color-accent-onfill` precedent.
2. **Radix `<Select>` for `GlassSelect`** — rejected. Not installed; adds a
   dependency and a portal/z-index surface for a control the native `<select>`
   handles accessibly. Styled-native keeps parity with `GlassInput` trivially.
3. **Per-component reduced-motion handling** — rejected. High-volume, easy to
   miss on new components; one global rule is complete and self-maintaining.
4. **Reusing `--color-bg-active` for selection** — rejected. It's a neutral grey
   (transient/pressed semantic) and reads identical to hover on some surfaces —
   exactly the workspace-row bug we're removing.

## References

- Audit: `docs/design/DESIGN-AUDIT-2026-07-12.md` (T1–T5, systemic #2/#6/#7,
  state-coverage census, Batch 0/1/4)
- Tokens: `src/index.css`
- Primitives to build in: `src/components/ui/`
- Existing conventions: `GlassButton.tsx` (focus ring, variants),
  `GlassInput.tsx` (`baseClasses`), `MergeToMainDialog.tsx` /
  `RenameWorkspaceModal.tsx` / `GitInitConfirmModal.tsx` (dialog drift),
  `WorkspaceActionsMenu.tsx` (hand-rolled Confirm/Error), `humanizeError.ts`
