import { GitCompareArrows } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";

/**
 * The "section changed on disk" inline prompt (spec F4). Raised when a save hits
 * a stale-mtime conflict, or when the ticket-watcher reports an external edit to
 * a section being edited. Mirrors the `MergeToMainDialog`/conflict family —
 * NEVER a dead end: Reload takes the on-disk version; Keep-mine re-saves the
 * user's draft against the fresh mtime.
 *
 * Honesty (Architect Stage-1 #1): Phase 2's agent is read-only on the brief, so
 * the external writer is the human's editor or git — attributed NEUTRALLY
 * ("changed on disk"), never claimed to be the agent.
 */
export function OnDiskChangePrompt({
  onReload,
  onKeepMine,
  pending = false,
}: {
  onReload: () => void;
  onKeepMine: () => void;
  pending?: boolean;
}) {
  return (
    <div
      role="alert"
      data-testid="ondisk-change-prompt"
      className="mt-3 flex flex-wrap items-center gap-2.5 rounded-(--radius-control) border px-3 py-2.5 text-[12px]"
      style={{
        background: "color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface))",
        borderColor: "color-mix(in oklab, var(--color-warning) 32%, transparent)",
      }}
    >
      <GitCompareArrows
        className="size-3.5 shrink-0 text-(--color-warning)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-secondary)">
        This section changed on disk. Reload to take the new version, or keep
        your edits.
      </span>
      <div className="ml-auto flex items-center gap-2">
        <GlassButton
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={onReload}
          data-testid="ondisk-reload"
        >
          Reload
        </GlassButton>
        <GlassButton
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onKeepMine}
          data-testid="ondisk-keep-mine"
        >
          Keep mine
        </GlassButton>
      </div>
    </div>
  );
}
