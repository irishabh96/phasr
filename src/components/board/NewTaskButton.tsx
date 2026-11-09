import { Button } from "@/components/ui/Button";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { Kbd } from "@/components/ui/Kbd";
import { SHORTCUTS } from "@/lib/shortcuts";

/** The screen's one primary: "New task", with ⌘N in the tooltip (not a chip in the button). */
export function NewTaskButton({ onNewTask }: { onNewTask: (() => void) | null }) {
  const keys = SHORTCUTS.newWorkspace.display.join("");
  return (
    <GlassTooltip
      side="bottom"
      content={
        <span className="flex items-center gap-1.5">
          New task <Kbd>{keys}</Kbd>
        </span>
      }
    >
      <Button
        variant="primary"
        className="h-[28px] px-[12px]"
        disabled={!onNewTask}
        aria-keyshortcuts="Meta+N"
        onClick={() => onNewTask?.()}
      >
        New task
      </Button>
    </GlassTooltip>
  );
}
