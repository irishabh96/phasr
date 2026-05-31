import { Bot } from "lucide-react";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { AGENT_ICON_DATA_URIS } from "@/lib/agentIcons";
import { useAgents } from "@/lib/hooks/useAgents";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface WorkspaceAgentToolbarProps {
  workspaceId: string;
}

const AGENT_ICON_LABELS: Record<string, string> = {
  claude: "C",
  codex: "O",
  copilot: "GH",
  opencode: "OC",
  gemini: "G",
};

const AGENT_ICON_COLORS: Record<string, string> = {
  claude: "text-[#d97757]",
  codex: "text-[#f5f5f5]",
  copilot: "text-[#7dd37d]",
  opencode: "text-[#d6d5d2]",
  gemini: "text-[#6aa7ff]",
};

export function WorkspaceAgentToolbar({
  workspaceId,
}: WorkspaceAgentToolbarProps) {
  const { data: agents } = useAgents();
  const openInnerTerminalTab = useUiStore((s) => s.openInnerTerminalTab);
  const allAgents = agents ?? [];

  if (allAgents.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-t border-(--glass-border-hairline) px-4">
      {allAgents.map((agent) => {
        const key = agent.agent;
        return (
          <GlassTooltip
            key={agent.agent}
            content={`Run ${agent.label}`}
            side="bottom"
          >
            <button
              type="button"
              onClick={() =>
                openInnerTerminalTab(workspaceId, {
                  title: agent.label,
                  initialCommand: agent.command,
                })
              }
              className={cn(
                "group/agent flex h-7 items-center gap-1.5 rounded-[8px] border border-transparent px-2 text-[12px]",
                "text-(--color-text-secondary) outline-none",
                "transition-[background-color,border-color,color,transform,box-shadow] duration-150",
                "hover:-translate-y-px hover:border-[color-mix(in_oklab,var(--color-accent-500)_35%,transparent)]",
                "hover:bg-[color-mix(in_oklab,var(--color-accent-500)_10%,var(--color-bg-hover))] hover:text-(--color-text-primary)",
                "hover:shadow-[0_6px_16px_rgba(0,0,0,0.18)]",
                "active:translate-y-0 active:shadow-none",
                "focus-visible:border-(--color-border-strong) focus-visible:bg-(--color-bg-hover) focus-visible:text-(--color-text-primary)",
              )}
            >
              <AgentIcon nameKey={key} />
              <span className="leading-none">{agent.label}</span>
            </button>
          </GlassTooltip>
        );
      })}
    </div>
  );
}

function AgentIcon({ nameKey }: { nameKey: string }) {
  const mappedIcon =
    AGENT_ICON_DATA_URIS[nameKey as keyof typeof AGENT_ICON_DATA_URIS];
  if (mappedIcon) {
    return (
      <img
        src={mappedIcon}
        alt=""
        className="h-3.5 w-3.5 shrink-0 transition-[filter,transform] duration-150 group-hover/agent:scale-110 group-hover/agent:brightness-125"
      />
    );
  }
  const label = AGENT_ICON_LABELS[nameKey];
  if (!label) {
    return (
      <Bot
        size={13}
        className="transition-transform duration-150 group-hover/agent:scale-110"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[5px] bg-(--color-bg-elevated) px-1 text-[9px] font-bold leading-none",
        "transition-[background-color,transform] duration-150 group-hover/agent:scale-110 group-hover/agent:bg-[color-mix(in_oklab,var(--color-accent-500)_16%,var(--color-bg-elevated))]",
        AGENT_ICON_COLORS[nameKey],
      )}
    >
      {label}
    </span>
  );
}
