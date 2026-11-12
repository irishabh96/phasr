import { Check, ChevronDown, MessageSquareText, Terminal as TerminalIcon } from "lucide-react";
import { disposeMainTerminal } from "@/components/Terminal";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/Menu";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { agentViewOf, type AgentView } from "@/lib/transcript/contract";
import { useSetAgentView } from "@/lib/transcript/useAgentView";
import type { Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The agent tab's caret: "View as transcript" / "View as terminal" (spec
 * §3, pane menu). Claude tasks only; the caller decides that. Opens from
 * the caret or a right-click on the tab (`open` is controlled for that).
 */
export function AgentViewMenu({
  workspace,
  open,
  onOpenChange,
  className,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const setView = useSetAgentView(workspace);
  const view = agentViewOf(workspace);

  const choose = (next: AgentView) => {
    if (next === view || setView.isPending) return;
    setView.mutate(next, {
      // Either way the old emulator is done: the transcript has no PTY, and
      // the terminal comes back attached to the resumed session.
      onSuccess: () => disposeMainTerminal(workspace.id),
      onError: (err) =>
        showToast({
          intent: "error",
          title: next === "terminal" ? "Couldn't switch to the terminal" : "Couldn't switch to the transcript",
          message: humanizeError(err),
        }),
    });
  };

  return (
    <Menu open={open} onOpenChange={onOpenChange} modal={false}>
      <MenuTrigger asChild>
        <span
          role="button"
          tabIndex={-1}
          aria-label="Agent view"
          data-agent-view-trigger
          // The tab itself activates on click; the caret only opens the menu.
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "-mr-[4px] grid size-[16px] place-items-center rounded-(--radius-chip) text-(--color-text-muted) opacity-60 transition-opacity duration-(--dur-1) ease-(--ease-out)",
            "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) hover:opacity-100 group-hover/pane-tab:opacity-100 data-[state=open]:opacity-100",
            className,
          )}
        >
          <ChevronDown className="size-[12px]" aria-hidden />
        </span>
      </MenuTrigger>
      <MenuContent width={210}>
        <MenuLabel>Agent view</MenuLabel>
        <MenuItem
          icon={<MessageSquareText className="size-[14px]" />}
          trailing={view === "transcript" ? <Check className="size-[13px] text-(--color-text-muted)" aria-hidden /> : null}
          onSelect={() => choose("transcript")}
        >
          View as transcript
        </MenuItem>
        <MenuItem
          icon={<TerminalIcon className="size-[14px]" />}
          trailing={view === "terminal" ? <Check className="size-[13px] text-(--color-text-muted)" aria-hidden /> : null}
          onSelect={() => choose("terminal")}
        >
          View as terminal
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
