import {
  FolderGit2,
  Pencil,
  SquareChevronRight,
  Terminal as TerminalIcon,
  Trash2,
  Zap,
} from "lucide-react";
import { useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { humanizeError } from "@/lib/humanizeError";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { formatAbsolute, formatRelative } from "@/lib/time";
import type { Note } from "@/lib/types";
import { cn } from "@/lib/utils";

const BODY_CLAMP_LINES = 8;

function OriginIcon({ kind }: { kind: Note["originKind"] }) {
  const cls = "shrink-0 text-(--color-text-muted)";
  switch (kind) {
    case "workspace":
      return <Zap size={11} className={cls} />;
    case "terminal":
      return <TerminalIcon size={11} className={cls} />;
    case "runCommand":
      return <SquareChevronRight size={11} className={cls} />;
    case "repository":
      return <FolderGit2 size={11} className={cls} />;
  }
}

export interface NoteRowProps {
  note: Note;
  /** Whether the origin workspace still exists (live-resolved by the panel). */
  originWorkspaceAlive: boolean;
  onSave: (body: string, expectedUpdatedAt: string) => Promise<void>;
  onDelete: () => void;
}

/**
 * One note: body (pre-wrap, clamped with "Show more"), provenance meta
 * line, always-visible edit/delete actions, inline editor with the
 * shared ⌘↵ / Esc bindings. Save failures keep the text and offer Retry.
 */
export function NoteRow({
  note,
  originWorkspaceAlive,
  onSave,
  onDelete,
}: NoteRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The "edited" badge tolerates sub-second insert jitter.
  const edited =
    Date.parse(note.updatedAt) - Date.parse(note.createdAt) > 1000;
  const isLong = note.body.split("\n").length > BODY_CLAMP_LINES;

  const beginEdit = () => {
    setDraft(note.body);
    setSaveError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError(null);
    setDraft(note.body);
  };

  const save = async () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === note.body || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(trimmed, note.updatedAt);
      setEditing(false);
    } catch (err) {
      setSaveError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchShortcut(e.nativeEvent as KeyboardEvent, SHORTCUTS.submitForm)) {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const canSave = draft.trim().length > 0 && draft.trim() !== note.body;

  return (
    <li>
      <article
        aria-label={`Note from ${note.originLabel}${
          note.originWorkspaceName ? `, ${note.originWorkspaceName}` : ""
        }, ${formatRelative(note.createdAt)}`}
        className="group flex flex-col gap-2 px-3 py-3 transition-colors duration-100 hover:bg-(--color-bg-hover)"
      >
        {editing ? (
          <div className="flex flex-col gap-2">
            <GlassTextarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleEditorKeyDown}
              rows={Math.min(Math.max(draft.split("\n").length, 3), 12)}
              autoFocus
              disabled={saving}
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
            <div className="flex h-8 items-center justify-between gap-2">
              <span className="text-[11px] leading-none text-(--color-text-muted)">
                ⌘↵ to save · Esc to cancel
              </span>
              <div className="flex items-center gap-2">
                <GlassButton
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={cancelEdit}
                >
                  Cancel
                </GlassButton>
                <GlassButton
                  variant="primary"
                  size="sm"
                  disabled={!canSave || saving}
                  {...(!canSave ? { title: "No changes to save" } : {})}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </GlassButton>
              </div>
            </div>
          </div>
        ) : (
          <>
            <p
              className={cn(
                "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[1.55] text-(--color-text-primary)",
                !expanded && "line-clamp-8",
              )}
            >
              {note.body}
            </p>
            {isLong && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="self-start text-[11px] text-(--color-text-muted) transition-colors hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
            <div className="flex h-8 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] leading-none text-(--color-text-muted)">
                <OriginIcon kind={note.originKind} />
                <span className="max-w-[120px] truncate font-medium text-(--color-text-secondary)">
                  {note.originLabel}
                </span>
                {note.originWorkspaceName && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="max-w-[110px] truncate">
                      {note.originWorkspaceName}
                    </span>
                    {!originWorkspaceAlive && (
                      <GlassTooltip
                        content="This workspace no longer exists."
                        side="top"
                      >
                        <span className="flex h-4 items-center rounded-full bg-(--color-bg-hover) px-1.5 text-[10px] font-medium">
                          Removed
                        </span>
                      </GlassTooltip>
                    )}
                  </>
                )}
                <span aria-hidden>·</span>
                <GlassTooltip content={formatAbsolute(note.createdAt)} side="top">
                  <time dateTime={note.createdAt} className="shrink-0">
                    {formatRelative(note.createdAt)}
                  </time>
                </GlassTooltip>
                {edited && (
                  <GlassTooltip
                    content={`Edited ${formatAbsolute(note.updatedAt)}`}
                    side="top"
                  >
                    <span className="shrink-0">· edited</span>
                  </GlassTooltip>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  aria-label="Edit note"
                  className="text-(--color-text-muted) hover:text-(--color-text-primary) group-hover:text-(--color-text-secondary)"
                  onClick={beginEdit}
                >
                  <Pencil size={12} />
                </GlassButton>
                <GlassButton
                  variant="ghost"
                  size="icon"
                  aria-label="Delete note"
                  className="text-(--color-text-muted) hover:!text-(--color-danger) group-hover:text-(--color-text-secondary)"
                  onClick={onDelete}
                >
                  <Trash2 size={12} />
                </GlassButton>
              </div>
            </div>
          </>
        )}
      </article>
    </li>
  );
}
