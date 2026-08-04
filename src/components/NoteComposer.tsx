import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
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
  /** Store counter — refocus the field whenever it changes. */
  focusRequest: number;
  /** Skip autofocus (the empty state renders the composer as an invitation). */
  autoFocus?: boolean;
}

/**
 * Summoned capture. Not pinned: the panel's resting state is a reading
 * surface, and this mounts only when the user asks for it (⌘⇧N, the
 * header +, the canvas row) or when there are no notes at all.
 *
 * Geometry is deliberately identical to a resting note body — same
 * `px-2 py-2`, 13px/1.5, same `mx-2` block — and the chrome is an
 * `outline` rather than a `border` so it takes no layout space. That's
 * what lets a saved note appear exactly where the typed text already
 * was, instead of jumping.
 */
export function NoteComposer({
  repositoryId,
  onCreate,
  focusRequest,
  autoFocus = true,
}: NoteComposerProps) {
  const draftKey = `${repositoryId}:new`;
  const draft = useUiStore((s) => s.noteDrafts[draftKey]) ?? "";
  const setNoteDraft = useUiStore((s) => s.setNoteDraft);
  const clearNoteDraft = useUiStore((s) => s.clearNoteDraft);
  const closeComposer = useUiStore((s) => s.closeNotesComposer);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [landing, setLanding] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) fieldRef.current?.focus();
  }, [focusRequest, autoFocus]);

  const trimmed = draft.trim();
  const canSave =
    trimmed.length > 0 && trimmed.length <= MAX_NOTE_LEN && !saving;
  const atCap = trimmed.length > MAX_NOTE_LEN;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    // Dissolve the chrome immediately — the text stays put and becomes
    // the note. The provenance line fades in only once the write lands,
    // so the motion is the receipt, not decoration.
    setLanding(true);
    try {
      await onCreate(trimmed);
      clearNoteDraft(draftKey);
      if (liveRef.current) liveRef.current.textContent = "Note saved";
      closeComposer();
    } catch (err) {
      setLanding(false);
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
      // The draft survives in the store — closing loses nothing.
      e.preventDefault();
      closeComposer();
    }
  };

  return (
    <div className="mx-2 my-1 flex flex-col gap-2">
      <textarea
        ref={fieldRef}
        value={draft}
        onChange={(e) => setNoteDraft(draftKey, e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a note…"
        // Always ≥2 rows so the first keystroke can't shove the list
        // down; grows only when a line actually wraps.
        rows={Math.min(Math.max(draft.split("\n").length, 2), 12)}
        disabled={saving}
        aria-label="Write a note"
        className={cn(
          "block w-full resize-none rounded-[8px] bg-transparent px-2 py-2",
          "text-[13px] leading-[1.5] text-(--color-text-primary)",
          "placeholder:text-(--color-text-muted)",
          "outline outline-1 -outline-offset-1 outline-(--glass-border-hairline)",
          "focus:outline-2 focus:outline-(--color-focus-ring)",
          "transition-[outline-color,background-color] duration-[var(--duration-glass)] [transition-timing-function:var(--ease-glass)]",
          landing && "outline-transparent",
          saveError && "outline-2 outline-(--color-danger)",
        )}
      />

      {saveError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-[6px] bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)] px-2 py-1.5"
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

      {/* The keys are taught by the canvas row and the + tooltip; a
          permanent hint line under the field is noise you read once.
          Fixed h-8 so the block doesn't jitter when the counter appears;
          right edge aligns with the field's outline, not row content. */}
      <div className="flex h-8 items-center justify-end gap-2">
        {trimmed.length > COUNTER_THRESHOLD && (
          <span
            className={cn(
              "text-[11px] leading-none tabular-nums",
              atCap
                ? "text-(--color-danger-text)"
                : "text-(--color-text-muted)",
            )}
            {...(atCap
              ? {
                  title: `Notes are limited to ${MAX_NOTE_LEN.toLocaleString()} characters`,
                }
              : {})}
          >
            {trimmed.length.toLocaleString()} / {MAX_NOTE_LEN.toLocaleString()}
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
      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}
