# Spec: Track F5 — Smart selection (+ folding design gate)

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** F (features) · **Ships as:** 0.6.x · **Size:** ~1–2 days (selection) + a design pass (folding)
**Depends on:** nothing for smart selection. Folding depends on **F2** (marks define the
extent to fold) and an engine design pass.
**Provenance:** derived from a local iTerm2 source read, 2026-08-27
(`SmartSelectionController.m:39`).

## Objective

Two items, deliberately unequal:

- **Smart selection** — *implement*. A double-click selects the meaningful token (URL, path,
  SHA, issue ref) instead of a character-class run.
- **Folding** — **design document only, then a go/no-go.** Do not implement.

## User story

- As a developer double-clicking a file path in agent output, I want the whole path selected,
  so I can paste it — instead of getting the fragment between two slashes.
- As a developer double-clicking a commit SHA or a PR reference, I want the whole token.

## Part 1 — Smart selection (implement)

### The mechanism: precision-weighted scoring

Each rule is a regex plus a **precision multiplier**. For a double-click, every rule is
evaluated at the click position; the winner is the highest **score**:

```
score = match length × precision multiplier
```

iTerm2's multiplier ladder spans **0.00001 … 1 000 000** — nine orders of magnitude, which is
the point. A very loose rule with a long match must still lose to a precise rule with a short
match. Use the ladder as a set of tiers rather than arbitrary numbers:

| Tier | Multiplier | Meaning | phasr rules at this tier |
|---|---|---|---|
| Very low | `0.00001` | catch-all / very loose | (reserve; the existing char-class run is the true fallback) |
| Low | `0.001` | loose, often wrong | bare word-ish runs with punctuation |
| Normal | `1` | ordinary confidence | quoted strings |
| High | `1000` | distinctive shape | absolute/relative file paths, UUIDs |
| Very high | `1000000` | unmistakable | URLs with a scheme, 7–40 hex SHAs, `owner/repo#123` issue refs |

### Rules for phasr

Paths · SHAs (7–40 hex) · PR/issue refs (`#123`, `owner/repo#123`) · URLs · UUIDs.

### Acceptance criteria

1. **Double-click selects the whole token** for each rule class: a URL with a scheme, an
   absolute path, a relative path with an extension, a 7-char and a 40-char SHA, `#123`,
   `owner/repo#123`, and a UUID. Each asserted with the exact expected extent.
2. **Scoring is `length × multiplier`, highest wins**, and this is directly unit-tested with a
   case where a *shorter, more precise* match beats a *longer, looser* one. That case is the
   whole reason the ladder exists; a test suite without it has not tested scoring.
3. **Ties are broken deterministically** (documented rule — e.g. higher multiplier first,
   then longer match, then leftmost). No dependence on rule declaration order.
4. **Fallback is preserved.** Where no rule matches, the current behaviour stands: the
   maximal run of one `CharClass` (`src/lib/terminal/selection.ts:40`), which deliberately has
   an `"other"` class so that double-clicking a space, a box-drawing character or a `:` always
   selects *something*. Regression: double-clicking blank space still selects the blank run.
5. **Existing selection behaviour is unchanged where it should be.** `WORD_PUNCTUATION`
   (`selection.ts:29`) currently makes a double-click on a URL stop at the scheme — matching
   iTerm's plain double-click — while whole-URL opening is ⌘-click's job. Smart selection
   **changes** that for URLs by design; the change must be deliberate, noted in the PR, and
   `e2e/terminal-selection.spec.ts` + `src/lib/terminal/selection.test.ts` updated with intent
   rather than to make red go green.
6. **Triple-click is untouched**: `logicalLineRange` (`selection.ts:97`) still selects the
   logical line, still bounded by the visible viewport so a screen of full-width rows cannot
   walk the whole scrollback.
7. **Wide glyphs and graphemes are handled**: a rule must not match across a double-wide
   glyph's trailing spacer (rows are passed one entry per **column**, `""` for an unwritten
   cell — `runAtColumn`'s contract, `selection.ts:62`).
8. **No regex catastrophic backtracking.** Every rule is bounded; a pathological row (e.g.
   200 columns of `/`) does not stall a frame. Asserted with a timing bound in the unit test.
9. **Rules are data, not code.** The rule set is a declarative table so rules can be added
   without touching the scorer — and so criterion 2's test can inject synthetic rules.

### #PATH_DECISION — extend `selection.ts`, do not replace it

`src/lib/terminal/selection.ts` is already the pure, unit-tested policy layer for selection
(`classifyChar`, `runAtColumn`, `logicalLineRange`), and its comments record *why* each
behaviour exists — including the bug that motivated the `"other"` class ("ghostty-web returned
null for any non-word cell, so double-clicking a space … did nothing at all, which is
indistinguishable from 'double-click is broken'").

**Decision: smart selection is a new scoring layer *in front of* `runAtColumn`, not a
replacement for it.** Rules run first; `runAtColumn` is the fallback. This keeps every
existing test meaningful and makes the new behaviour additive.

### Reuse — do not rewrite the tokenizers

`src/lib/terminal/links.ts` already contains, tested: `findLinkTokens` (:54),
`findPathTokens` (:74), `resolvePathToken` (:89), `isOpenableUrl` (:139),
`createTerminalLinkSource` (:160), with `LinkToken` (:42) and `PathToken` (:33) types and
`links.test.ts` coverage. URL and path rules should be expressed over these, not with a
second set of regexes that drift from the ones ⌘-click uses. A URL that is clickable and a
URL that is double-click-selectable must be the same URL.

## Part 2 — Folding (**design document only — do not implement**)

**Goal:** collapse a command's output (extent defined by F2's OSC 133 `C`→`D` marks) to a
single line.

**Why this is gated:** folding needs **engine cooperation to skip rows at render**. There is
no such capability in ghostty-web today, and the renderer's row loop
(`node_modules/ghostty-web/dist/ghostty-web.js:1498–1512`) maps canvas row → buffer row
positionally. Introducing a fold means introducing a row-mapping indirection into the hot path
that perf Phase 2 just spent days optimising, and it interacts with: dirty tracking, the
scrolled-back offset (`vF`), selection coordinates, the scrollbar, and F4's absolute-row
results.

### Acceptance criteria for Part 2

1. A design document exists covering: the engine patch surface required, the interaction with
   P2's render loop and P1's frame scheduling, the interaction with `reflow.ts`'s rebuild-on-
   width-change policy, selection and search behaviour across a fold, and how a fold is
   persisted (or not) across a resize.
2. The document contains a **cost estimate** and an explicit **go/no-go recommendation**.
3. **No folding implementation is merged** under this spec. If the gate opens, folding gets
   its own spec and its own release slot.

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| Selection policy layer to extend | `src/lib/terminal/selection.ts` — `WORD_PUNCTUATION` (:29), `CharClass` (:31), `classifyChar` (:40), `ColumnRange` (:50), `runAtColumn` (:62), `RowRange` (:81), `logicalLineRange` (:97) |
| Existing unit tests | `src/lib/terminal/selection.test.ts` |
| Existing e2e | `e2e/terminal-selection.spec.ts` |
| Token detectors to reuse | `src/lib/terminal/links.ts` — `PathToken` (:33), `LinkToken` (:42), `findLinkTokens` (:54), `findPathTokens` (:74), `resolvePathToken` (:89), `isOpenableUrl` (:139), `createTerminalLinkSource` (:160); tests in `links.test.ts`, e2e in `e2e/terminal-links.spec.ts` |
| Double-click host defence (existing, must not regress) | shipped in v0.4.1 — "a double-click defends the contenteditable host everywhere" |
| Renderer row loop (folding's problem) | `node_modules/ghostty-web/dist/ghostty-web.js:1498–1512` |
| Reflow rebuild policy (folding's other problem) | `src/lib/terminal/reflow.ts:23,39` |
| F2 marks (folding's extent source) | `specs/f2-command-marks-osc133-spec.md` |

## Test / evidence plan

- **vitest** (`pnpm test`) — the primary suite for Part 1; the scorer and rule set are pure
  functions over a row of strings. All nine acceptance criteria for Part 1 except the paint
  half of 5 are unit-testable, including the deliberately-adversarial cases (criterion 2's
  short-precise-beats-long-loose, criterion 8's backtracking bound).
- **Playwright** (`e2e/terminal-selection.spec.ts`, plus `terminal-links.spec.ts` for the
  URL-consistency claim): real double-clicks on a real surface, asserting the selected text.
  Run under `pnpm test:e2e:webkit` — selection and canvas text metrics differ by engine, which
  is exactly what that config exists for.
- **The mocked-IPC harness is adequate for this track**: it writes bytes into a real surface
  and drives real mouse events; nothing here crosses the IPC boundary or depends on a real
  PTY. This is the one Track F spec with no transport-layer blind spot.
- **Manual:** a `docs/MANUAL-VERIFICATION.md` entry for double-click behaviour on a packaged
  build, since OS-level text-editing and clipboard behaviour differ from the browser.
- **Part 2 evidence** is the design document plus the recorded go/no-go.

## Out of scope

Implementing folding · user-editable smart-selection rules (the rule table is internal in this
version) · context-menu actions derived from the matched token (e.g. "open PR #123") ·
selection across a fold · changing ⌘-click link behaviour · portholes, composer, or OSC 1337
session variables (0.7+ candidates, not this program).
