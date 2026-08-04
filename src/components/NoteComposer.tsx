import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";
import { humanizeError } from "@/lib/humanizeError";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Keep in sync with MAX_NOTE_LEN in commands/notes.rs. */
const MAX_NOTE_LEN = 50_000;
const COUNTER_THRESHOLD = Math.floor(MAX_NOTE_LEN * 0.9);

export interface NoteComposerProps {
  repositoryId: string;
  onCreate: (body: string) => Promise<void>;
  /** Store counter — focus + expand the field when it changes. */
  focusRequest: number;
}

/**
 * Sticky "Write a note…" field. Collapsed to one row until focused;
 * the draft persists in the ui store (keyed per repository) so a rail
 * collapse or tab switch never loses text. ⌘↵ saves, Esc collapses
 * (draft retained — nothing to confirm because nothing is lost).
 */
export function NoteComposer({
  repositoryId,
  onCreate,
  focusRequest,
}: NoteComposerProps) {
  const draftKey = `${repositoryId}:new`;
  const draft = useUiStore((s) => s.noteDrafts[draftKey]) ?? "";
  const setNoteDraft = useUiStore((s) => s.setNoteDraft);
  const clearNoteDraft = useUiStore((s) => s.clearNoteDraft);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusRequest > 0) fieldRef.current?.focus();
  }, [focusRequest]);

  // Height is a pure function of CONTENT, never of focus. Growing on
  // focus (and shrinking on blur) reflows the list underneath, so a
  // click on a note's action lands where the row used to be.
  const expanded = draft.length > 0;
  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed.length <= MAX_NOTE_LEN && !saving;
  const atCap = trimmed.length > MAX_NOTE_LEN;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onCreate(trimmed);
      clearNoteDraft(draftKey);
      if (liveRef.current) liveRef.current.textContent = "Note saved";
      // Keep focus in the field — rapid capture is the point.
      fieldRef.current?.focus();
    } catch (err) {
      setSaveError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchShortcut(e.nativeEvent as KeyboardEvent, SHORTCUTS.submitForm)) {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === "Escape") {
      // Draft persists in the store — collapsing loses nothing.
      e.preventDefault();
      fieldRef.current?.blur();
    }
  };

  return (
    <div className="flex flex-col gap-2 border-b border-(--color-border-subtle) bg-(--color-bg-surface) p-2">
      <GlassTextarea
        ref={fieldRef}
        value={draft}
        onChange={(e) => setNoteDraft(draftKey, e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a note…"
        rows={expanded ? Math.min(Math.max(draft.split("\n").length, 3), 12) : 1}
        disabled={saving}
        aria-label="Write a note"
      />
      {saveError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-[8px] bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)] px-2.5 py-1.5"
        >
          <span className="min-w-0 truncate text-[12px] text-(--color-danger-text)">
            {saveError}
          </span>
          <GlassButton
            variant="ghost"
            size="sm"
            className="!h-6 shrink-0 px-2 text-[11px]"
            onClick={() => void save()}
          >
            Retry
          </GlassButton>
        </div>
      )}
      {expanded && (
        <div className="flex h-8 items-center justify-between gap-2">
          <span className="text-[11px] leading-none text-(--color-text-muted)">
            ⌘↵ to save
          </span>
          <div className="flex items-center gap-2">
            {trimmed.length > COUNTER_THRESHOLD && (
              <span
                className={cn(
                  "text-[11px] leading-none tabular-nums",
                  atCap
                    ? "text-(--color-danger-text)"
                    : "text-(--color-text-muted)",
                )}
                {...(atCap
                  ? { title: `Notes are limited to ${MAX_NOTE_LEN.toLocaleString()} characters` }
                  : {})}
              >
                {trimmed.length.toLocaleString()} /{" "}
                {MAX_NOTE_LEN.toLocaleString()}
              </span>
            )}
            <GlassButton
              variant="primary"
              size="sm"
              disabled={!canSave}
              {...(trimmed.length === 0
                ? { title: "Write something to save" }
                : {})}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save note"}
            </GlassButton>
          </div>
        </div>
      )}
      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}
