import { NotebookPen } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { cn } from "@/lib/utils";

/**
 * The Notes entry point — same ghost icon button in the workspace
 * header cluster and the repo-home tab bar. It TOGGLES: pressing it
 * while the rail is already showing Notes closes it again.
 *
 * No count badge by design: a note count is not urgent and must not
 * compete with the coral Changes pill.
 */
export function NotesEntryButton({
  onClick,
  active = false,
}: {
  onClick: () => void;
  /** Rail is open on Notes — the button reads as pressed. */
  active?: boolean;
}) {
  return (
    <GlassTooltip
      content={`${active ? "Hide" : "Show"} repository notes`}
      side="bottom"
    >
      <GlassButton
        variant="ghost"
        size="icon"
        aria-label="Repository notes"
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          active && "bg-(--color-bg-active) text-(--color-text-primary)",
        )}
      >
        <NotebookPen size={14} />
      </GlassButton>
    </GlassTooltip>
  );
}
