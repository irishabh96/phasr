import type { BriefSectionContent } from "@/lib/types";

/**
 * The per-section edit state machine for the Brief tab (spec F3). Read-first;
 * an edit opens a `GlassTextarea`; a save calls `write_ticket_section` with the
 * section's optimistic `baseMtimeMs`. The two outcomes:
 *
 * - `saved`    → ADOPT `result.section.mtimeMs` as the new base and return to
 *                read mode (so the next save is checked against the fresh mtime).
 * - `conflict` → the base was stale; keep the user's draft and offer
 *                **Reload** (take `onDisk`) / **Keep-mine** (re-save against
 *                `onDisk.mtimeMs`). NOTHING is silently overwritten.
 *
 * Pure & framework-free so it's trivially unit-tested. The async
 * `write_ticket_section` call itself lives in `SectionEditor`; this reducer only
 * models the transitions (the view passes the correct `baseMtimeMs` — which is
 * always `state.base.mtimeMs`, including after `keepMine` adopts `onDisk`).
 */
export type SectionMode = "read" | "edit" | "saving" | "conflict";

export interface SectionState {
  /** The persisted content + mtime the current buffer is based on. */
  base: BriefSectionContent;
  mode: SectionMode;
  /** The edit buffer (draft) while editing / saving / resolving a conflict. */
  draft: string;
  /** On a conflict, the fresher on-disk version to reload/re-save against. */
  onDisk: BriefSectionContent | null;
  /** Last write error (humanized at the view); preserved so the buffer isn't lost. */
  error: unknown;
}

export type SectionAction =
  /** External refresh (query refetch / soft-refresh) — adopted ONLY in read mode. */
  | { type: "reset"; base: BriefSectionContent }
  /** An external on-disk change to a section being EDITED → raise the conflict prompt. */
  | { type: "externalChange"; onDisk: BriefSectionContent }
  | { type: "edit" }
  | { type: "change"; draft: string }
  | { type: "cancel" }
  | { type: "save" }
  | { type: "saved"; section: BriefSectionContent }
  | { type: "conflict"; onDisk: BriefSectionContent }
  | { type: "error"; error: unknown }
  | { type: "reload" }
  | { type: "keepMine" };

export function initSectionState(base: BriefSectionContent): SectionState {
  return { base, mode: "read", draft: "", onDisk: null, error: null };
}

export function sectionReducer(
  state: SectionState,
  action: SectionAction,
): SectionState {
  switch (action.type) {
    case "reset":
      // Only adopt an external base when idle — never clobber an open buffer.
      if (state.mode !== "read") return state;
      return { ...state, base: action.base };

    case "externalChange":
      // A concurrent on-disk edit to a section the user is editing: surface the
      // conflict prompt instead of a silent overwrite (F4). No-op if not editing.
      if (state.mode !== "edit") return state;
      return { ...state, mode: "conflict", onDisk: action.onDisk, error: null };

    case "edit":
      if (state.mode !== "read") return state;
      return { ...state, mode: "edit", draft: state.base.content, error: null };

    case "change":
      if (state.mode !== "edit") return state;
      return { ...state, draft: action.draft };

    case "cancel":
      return { ...state, mode: "read", draft: "", onDisk: null, error: null };

    case "save":
      // Enter saving from edit (first save) or conflict (defensive). The view
      // writes with `state.base.mtimeMs` + `state.draft`.
      return { ...state, mode: "saving", error: null };

    case "saved":
      // ADOPT the returned section's mtime as the new base and return to read.
      return {
        base: action.section,
        mode: "read",
        draft: "",
        onDisk: null,
        error: null,
      };

    case "conflict":
      return { ...state, mode: "conflict", onDisk: action.onDisk, error: null };

    case "error":
      // Stay in edit with the draft intact so the user can retry.
      return { ...state, mode: "edit", error: action.error };

    case "reload":
      // Take the on-disk version wholesale, discarding the draft.
      if (!state.onDisk) return { ...state, mode: "read", error: null };
      return {
        base: state.onDisk,
        mode: "read",
        draft: "",
        onDisk: null,
        error: null,
      };

    case "keepMine":
      // Re-save the draft against the fresher on-disk mtime: adopt `onDisk` as
      // the base (so `base.mtimeMs === onDisk.mtimeMs`) and re-enter saving with
      // the draft preserved. The view then writes with the new base mtime.
      if (!state.onDisk) return state;
      return {
        base: state.onDisk,
        mode: "saving",
        draft: state.draft,
        onDisk: null,
        error: null,
      };

    default:
      return state;
  }
}
