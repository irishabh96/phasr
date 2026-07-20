import { Bot } from "lucide-react";

/**
 * The ambient co-editing banner (spec F4). Shown while THIS ticket's agent is
 * live (working / idle / resolving — derived from the workspace's honest state
 * by `BriefPanel`). WARN, never lock (open decision #6): edits always save; the
 * agent re-reads the brief at its next step. Uses the honest-status `info`
 * palette (the mockup `.coedit`), never coral.
 */
export function AgentWorkingBanner() {
  return (
    <div
      role="status"
      data-testid="agent-working-banner"
      className="flex items-center gap-2.5 rounded-(--radius-control) border px-3 py-2.5 text-[12px] text-(--color-text-secondary)"
      style={{
        background: "color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface))",
        borderColor: "color-mix(in oklab, var(--color-info) 30%, transparent)",
      }}
    >
      <Bot
        className="size-3.5 shrink-0 text-(--color-info)"
        aria-hidden="true"
      />
      <span>
        Agent is working from this brief. Your edits save now — the agent reads
        the brief again at its next step.
      </span>
    </div>
  );
}
