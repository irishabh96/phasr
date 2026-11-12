import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Agent monogram (A-System "AGENTS"): one fixed-size rounded square per
 * agent, everywhere. Monograms until official logos are licensed.
 */
export const AGENT_META: Record<Agent, { label: string; letter: string; color: string }> = {
  claude: { label: "Claude", letter: "C", color: "var(--color-agent-claude)" },
  codex: { label: "Codex", letter: "X", color: "var(--color-agent-codex)" },
  copilot: { label: "Copilot", letter: "P", color: "var(--color-agent-copilot)" },
  gemini: { label: "Gemini", letter: "G", color: "var(--color-agent-gemini)" },
  opencode: { label: "OpenCode", letter: "O", color: "var(--color-agent-opencode)" },
};

const SIZES = {
  xs: "size-3 rounded-[3px] text-[8px]",
  sm: "size-3.5 rounded-[3px] text-[9px]",
  md: "size-4 rounded-(--radius-chip) text-[10px]",
  lg: "size-5 rounded-[5px] text-[11px]",
} as const;

export function AgentMark({
  agent,
  size = "sm",
  withLabel = false,
  className,
}: {
  agent: Agent | null | undefined;
  size?: keyof typeof SIZES;
  withLabel?: boolean;
  className?: string;
}) {
  const meta = agent ? AGENT_META[agent] : null;
  const mark = (
    <span
      aria-hidden={withLabel || undefined}
      aria-label={withLabel ? undefined : (meta?.label ?? "Agent")}
      role={withLabel ? undefined : "img"}
      className={cn(
        "inline-grid shrink-0 place-items-center font-semibold leading-none text-(--color-text-inverse)",
        SIZES[size],
        !meta && "bg-(--color-text-faint)",
        !withLabel && className,
      )}
      style={meta ? { background: meta.color } : undefined}
    >
      {meta?.letter ?? "?"}
    </span>
  );
  if (!withLabel) return mark;
  return (
    <span className={cn("inline-flex items-center gap-[5px]", className)}>
      {mark}
      {meta?.label ?? "Agent"}
    </span>
  );
}
