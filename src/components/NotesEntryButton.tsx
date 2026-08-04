import { NotebookPen } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { SHORTCUTS } from "@/lib/shortcuts";

/**
 * The Notes entry point — same ghost icon button in the workspace
 * header cluster and the repo-home tab bar. No count badge by design:
 * a note count is not urgent and must not compete with the coral
 * Changes pill.
 */
export function NotesEntryButton({ onClick }: { onClick: () => void }) {
  return (
    <GlassTooltip
      content={`${SHORTCUTS.openNotes.label} (${SHORTCUTS.openNotes.display.join("")})`}
      side="bottom"
    >
      <GlassButton
        variant="ghost"
        size="icon"
        aria-label="Repository notes"
        onClick={onClick}
      >
        <NotebookPen size={14} />
      </GlassButton>
    </GlassTooltip>
  );
}
