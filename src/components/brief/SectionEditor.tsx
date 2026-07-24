import { Pencil } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";
import { Markdown } from "@/components/brief/Markdown";
import { OnDiskChangePrompt } from "@/components/brief/OnDiskChangePrompt";
import { SectionCard } from "@/components/brief/SectionCard";
import {
  initSectionState,
  sectionReducer,
} from "@/components/brief/briefSectionReducer";
import { formatDuration } from "@/lib/formatDuration";
import { humanizeError } from "@/lib/humanizeError";
import { tauri } from "@/lib/tauri";
import { useNow } from "@/lib/useNow";
import type { BriefSection, BriefSectionContent } from "@/lib/types";

/**
 * One brief section (Description / PRD / TRD) — read-first rendered markdown
 * with a per-section Edit affordance that swaps to a `GlassTextarea` (⌘↵ saves).
 * A save calls `write_ticket_section(baseMtimeMs)`: `saved` adopts the new mtime
 * in place; `conflict` raises the Reload / Keep-mine prompt (spec F3/F4). The
 * whole state machine lives in `briefSectionReducer` (unit-tested).
 *
 * NB: the textarea deliberately does NOT register as a `promptInsertTarget`
 * (Architect #3) — so a file dropped while editing attaches an asset, it does
 * not splice a path into the prose.
 */
export function SectionEditor({
  repositoryId,
  ticketId,
  sectionKey,
  label,
  section,
  onSaved,
}: {
  repositoryId: string;
  ticketId: string;
  sectionKey: BriefSection;
  label: string;
  section: BriefSectionContent;
  /** Patch the parent brief query cache so the adopted mtime is the new base. */
  onSaved: (section: BriefSectionContent) => void;
}) {
  const [state, dispatch] = useReducer(
    sectionReducer,
    section,
    initSectionState,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Adopt external refreshes: a refetch (soft-refresh after a ticket-changed
  // event, F4) updates the base while READING; while EDITING a genuine on-disk
  // divergence raises the conflict prompt instead of a silent overwrite.
  useEffect(() => {
    if (state.mode === "read") {
      dispatch({ type: "reset", base: section });
    } else if (
      state.mode === "edit" &&
      section.mtimeMs !== state.base.mtimeMs &&
      section.content !== state.base.content
    ) {
      dispatch({ type: "externalChange", onDisk: section });
    }
    // Intentionally keyed on the on-disk identity only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.mtimeMs, section.content]);

  // Focus the textarea when an edit opens.
  useEffect(() => {
    if (state.mode === "edit") textareaRef.current?.focus();
  }, [state.mode]);

  const runWrite = useCallback(
    async (baseMtimeMs: number | null, content: string) => {
      try {
        const result = await tauri.writeTicketSection(
          repositoryId,
          ticketId,
          sectionKey,
          content,
          baseMtimeMs,
        );
        if (result.kind === "saved") {
          dispatch({ type: "saved", section: result.section });
          onSaved(result.section);
        } else {
          dispatch({ type: "conflict", onDisk: result.onDisk });
        }
      } catch (e) {
        dispatch({ type: "error", error: e });
      }
    },
    [repositoryId, ticketId, sectionKey, onSaved],
  );

  const onSave = useCallback(() => {
    dispatch({ type: "save" });
    void runWrite(state.base.mtimeMs, state.draft);
  }, [runWrite, state.base.mtimeMs, state.draft]);

  const onKeepMine = useCallback(() => {
    const disk = state.onDisk;
    if (!disk) return;
    dispatch({ type: "keepMine" });
    void runWrite(disk.mtimeMs, state.draft);
  }, [runWrite, state.onDisk, state.draft]);

  const isEditing =
    state.mode === "edit" || state.mode === "saving" || state.mode === "conflict";
  const saving = state.mode === "saving";
  const isEmpty = state.base.content.trim() === "";

  const now = useNow(state.base.lastEditedAtMs != null);
  const meta = editedMeta(state.base, now);

  // An empty section shows the full-width "Write {label}" CTA below, so the
  // top-right Edit affordance would be a redundant second control for the same
  // action — suppress it and let the CTA be the single, discoverable entry.
  const action = isEditing ? (
    <span className="text-[11px] text-(--color-accent-text)">Markdown</span>
  ) : isEmpty ? null : (
    <button
      type="button"
      onClick={() => dispatch({ type: "edit" })}
      data-testid={`brief-edit-${sectionKey}`}
      className="inline-flex items-center gap-1.5 rounded-[6px] text-[11px] text-(--color-text-muted) transition-colors hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
    >
      <Pencil className="size-3" aria-hidden="true" />
      Edit
    </button>
  );

  return (
    <SectionCard
      testId={`brief-section-${sectionKey}`}
      variant="bare"
      title={isEditing ? `${label} · editing` : label}
      editing={isEditing}
      meta={isEditing ? null : meta}
      action={action}
    >
      {isEditing ? (
        <div>
          <GlassTextarea
            ref={textareaRef}
            value={state.draft}
            disabled={saving}
            onChange={(e) => dispatch({ type: "change", draft: e.target.value })}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                dispatch({ type: "cancel" });
              }
            }}
            rows={6}
            data-testid={`brief-textarea-${sectionKey}`}
            className="min-h-[96px] border-(--color-accent-500) font-mono text-[12px] shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-500)_12%,transparent)]"
          />

          {state.error ? (
            <p
              role="alert"
              className="mt-2 text-[11.5px] text-(--color-danger)"
            >
              {humanizeError(state.error)}
            </p>
          ) : null}

          {state.mode === "conflict" ? (
            <OnDiskChangePrompt
              onReload={() => dispatch({ type: "reload" })}
              onKeepMine={onKeepMine}
            />
          ) : (
            <div className="mt-2.5 flex justify-end gap-2">
              <GlassButton
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => dispatch({ type: "cancel" })}
              >
                Cancel
              </GlassButton>
              <GlassButton
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={onSave}
                data-testid={`brief-save-${sectionKey}`}
              >
                {saving ? "Saving…" : "Save"}
                {!saving ? (
                  <span className="ml-0.5 text-(--color-text-muted)">⌘↵</span>
                ) : null}
              </GlassButton>
            </div>
          )}
        </div>
      ) : isEmpty ? (
        <button
          type="button"
          onClick={() => dispatch({ type: "edit" })}
          data-testid={`brief-empty-${sectionKey}`}
          className="flex w-full items-center gap-2 rounded-[8px] border border-dashed border-(--color-border-default) px-3 py-2.5 text-left text-[12px] text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
        >
          <Pencil className="size-3" aria-hidden="true" />
          Write {label}
        </button>
      ) : (
        <Markdown>{state.base.content}</Markdown>
      )}
    </SectionCard>
  );
}

/**
 * The honest "last edited" line (spec F4). Phase 2 attributes edits to `"you"`
 * or NEUTRALLY (`null`) — NEVER "agent" (Architect #1). Omits the name when the
 * author is unknown; omits the line entirely when there's no timestamp.
 */
function editedMeta(base: BriefSectionContent, now: number): string | null {
  if (base.lastEditedAtMs == null) return null;
  const ago = formatDuration(Math.max(0, now - base.lastEditedAtMs));
  return base.lastEditedBy === "you"
    ? `last edited by you · ${ago} ago`
    : `edited · ${ago} ago`;
}
