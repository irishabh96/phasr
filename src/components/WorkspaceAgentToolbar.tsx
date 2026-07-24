import { Bot } from "lucide-react";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { AGENT_ICON_DATA_URIS } from "@/lib/agentIcons";
import { useAgents } from "@/lib/hooks/useAgents";
import { useUiStore } from "@/lib/store";
import { resolveTheme } from "@/lib/theme";
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

// Brand marks that are single-color WHITE SVGs — they vanish on the light
// theme's near-white surfaces. In light mode they're darkened to a neutral
// glyph so the toolbar reads in both themes. (Multi-tone logos like opencode
// carry dark fills already, so they're left untouched.)
const WHITE_ON_DARK_ICONS = new Set(["codex", "copilot"]);

export function WorkspaceAgentToolbar({
  workspaceId,
}: WorkspaceAgentToolbarProps) {
  const { data: agents } = useAgents();
  const openInnerTerminalTab = useUiStore((s) => s.openInnerTerminalTab);
  const theme = useUiStore((s) => s.theme);
  const isLight = resolveTheme(theme) === "light";
  const allAgents = agents ?? [];

  if (allAgents.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-t border-(--glass-border-hairline) px-4">
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
                "group/agent flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] border border-transparent px-2 text-[12px]",
                "text-(--color-text-secondary) outline-none",
                "transition-[background-color,border-color,color,transform] duration-150",
                // Flat, per the design language — depth comes from the coral
                // border + tint + a 1px lift, not a drop shadow.
                "hover:-translate-y-px hover:border-[color-mix(in_oklab,var(--color-accent-500)_35%,transparent)]",
                "hover:bg-[color-mix(in_oklab,var(--color-accent-500)_10%,var(--color-bg-hover))] hover:text-(--color-text-primary)",
                "active:translate-y-0",
                "focus-visible:border-(--color-accent-500) focus-visible:bg-(--color-bg-hover) focus-visible:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)]",
              )}
            >
              <AgentIcon nameKey={key} isLight={isLight} />
              <span className="leading-none">{agent.label}</span>
            </button>
          </GlassTooltip>
        );
      })}
    </div>
  );
}

function AgentIcon({
  nameKey,
  isLight,
}: {
  nameKey: string;
  isLight: boolean;
}) {
  const mappedIcon =
    AGENT_ICON_DATA_URIS[nameKey as keyof typeof AGENT_ICON_DATA_URIS];
  if (mappedIcon) {
    // A white brand mark disappears on the light theme's near-white surface —
    // darken it to a neutral glyph so the toolbar reads in both themes.
    const needsDarken = isLight && WHITE_ON_DARK_ICONS.has(nameKey);
    return (
      <img
        src={mappedIcon}
        alt=""
        className={cn(
          "h-3.5 w-3.5 shrink-0 transition-[filter,transform] duration-150 group-hover/agent:scale-110",
          needsDarken
            ? "[filter:brightness(0)] opacity-70 group-hover/agent:opacity-100"
            : "group-hover/agent:brightness-125",
        )}
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
