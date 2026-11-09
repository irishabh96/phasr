import { ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { formatElapsed } from "@/lib/board";
import { useNow } from "@/lib/hooks/useNow";
import { approvalKeyAllowed, isOverlayOpen } from "@/lib/keyboardGuards";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import type { Agent, Attention, AttentionResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

type ApprovalAttention = Attention;
type ApprovalResponse = AttentionResponse;

/** A-Polish 28px buttons in explicit px (1rem is 13px in this app). */
const btn28 = "h-[28px] px-[10px]";

const KIND_TITLE: Record<string, string> = {
  shell: "wants to run a shell command",
  edit: "wants to edit a file",
  tool: "wants to use a tool",
  question: "has a question for you",
  input: "is waiting for input",
  trust: "asks whether to trust this folder",
};

/**
 * Inline approval (A-States): the agent is paused on a permission prompt.
 * Allow once ⌘Y / Allow for this task / Deny ⌘⌫ press the agent's own keys
 * (backend `respond_to_attention`, guarded by the attention id so a stale
 * click can't answer a newer dialog). When the dialog wasn't recognised
 * (`canRespond` false) the card only points at the terminal.
 */
export function ApprovalCard({
  agent,
  attention,
  worktree,
  busy,
  allowForTask = true,
  onRespond,
  onOpenTerminal,
  onChangeDefault,
}: {
  agent: Agent | null;
  attention: ApprovalAttention;
  worktree: string | null;
  busy?: boolean;
  /**
   * Claude's second option is "always allow in this project": fine for a
   * throwaway worktree, permanent on your real repo — so in-place tasks
   * don't offer it.
   */
  allowForTask?: boolean;
  onRespond: (r: ApprovalResponse) => void;
  onOpenTerminal: () => void;
  onChangeDefault: () => void;
}) {
  const now = useNow(true);
  const name = agent ? AGENT_META[agent].label : "The agent";
  const isTrust = (attention.kind as string) === "trust";

  // ⌘Y allow once, ⌘⌫ deny. ⌘ only (Ctrl+Y is readline yank in a shell),
  // never auto-repeat, never while a response is in flight, never behind a
  // dialog or the Settings sheet. ⌘Y fires from the page or the agent's own
  // terminal; ⌘⌫ only from the page — in any terminal it is kill-line, and
  // in a field it deletes the line (see `approvalKeyAllowed`).
  useEffect(() => {
    if (!attention.canRespond) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.repeat || busy) return;
      const action = matchShortcut(e, SHORTCUTS.approveAgent)
        ? "allow"
        : matchShortcut(e, SHORTCUTS.denyAgent)
          ? "deny"
          : null;
      if (!action) return;
      if (isOverlayOpen() || !approvalKeyAllowed(action, e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onRespond(action === "allow" ? "allow-once" : "deny");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [attention.canRespond, attention.id, onRespond, busy]);

  // A-States card under the Polish rules: a warm surface step with a soft
  // amber ring instead of a border, no header divider, the command on an
  // inset block (no border), buttons secondary/ghost except Allow.
  return (
    <section
      role="alertdialog"
      aria-label={`${name} ${KIND_TITLE[attention.kind] ?? "needs you"}`}
      className="mx-[24px] mt-[12px] flex max-w-[640px] flex-col rounded-(--radius-card) bg-[color-mix(in_oklab,var(--color-warning)_6%,var(--color-bg-surface))] shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-warning)_32%,transparent)]"
    >
      <header className="flex items-center gap-[10px] px-[14px] pt-[10px] text-[13px]">
        <ShieldAlert className="size-[14px] shrink-0 text-(--color-warning)" aria-hidden />
        <span className="min-w-0 truncate font-medium text-(--color-warning)">
          {name} {KIND_TITLE[attention.kind] ?? "needs you"}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] tabular-nums text-(--color-text-muted)">
          waiting {formatElapsed(attention.since, now)}
        </span>
      </header>
      <div className="flex flex-col gap-[8px] px-[14px] pb-[12px] pt-[10px]">
        {attention.detail ? (
          <code className="block overflow-x-auto whitespace-pre rounded-(--radius-control) bg-(--color-bg-input) px-[10px] py-[8px] font-mono text-[12px] text-(--color-text-primary)">
            {attention.detail}
          </code>
        ) : (
          <p className="m-0 text-[12.5px] text-(--color-text-secondary)">{attention.title}</p>
        )}
        {worktree || attention.source === "heuristic" ? (
          <div className="flex flex-wrap gap-x-[14px] gap-y-[4px] text-[11px] text-(--color-text-muted)">
            {worktree ? (
              <span>
                in <span className="font-mono text-(--color-text-secondary)">{worktree.replace(/^\/Users\/[^/]+/, "~")}</span>
              </span>
            ) : null}
            {attention.source === "heuristic" ? (
              <span>
                Detected from the terminal output · <Kbd tone="bare">answers press the agent&apos;s own keys</Kbd>
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-[8px] pt-[4px]">
          {attention.canRespond ? (
            <>
              <Button variant="primary" size="sm" className={cn(btn28, "px-[12px]")} disabled={busy} shortcut="⌘Y" onClick={() => onRespond("allow-once")}>
                {isTrust ? "Trust folder" : "Allow once"}
              </Button>
              {allowForTask && !isTrust ? (
                <Button variant="secondary" size="sm" className={btn28} disabled={busy} onClick={() => onRespond("allow-task")}>
                  Allow for this task
                </Button>
              ) : null}
              <Button variant="danger" size="sm" className={btn28} disabled={busy} shortcut="⌘⌫" onClick={() => onRespond("deny")}>
                {isTrust ? "Exit agent" : "Deny"}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" className={btn28} onClick={onOpenTerminal}>
              Answer in the terminal
            </Button>
          )}
          <span className="flex-1" />
          {isTrust ? null : (
            <button
              type="button"
              onClick={onChangeDefault}
              className="rounded-(--radius-chip) text-[11px] text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
            >
              Change default…
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
