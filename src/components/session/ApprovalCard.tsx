import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { formatElapsed } from "@/lib/board";
import { useNow } from "@/lib/hooks/useNow";
import { approvalKeyAllowed, isOverlayOpen } from "@/lib/keyboardGuards";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import type { Agent, Attention, AttentionResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

type ApprovalAttention = Attention;
type ApprovalResponse = AttentionResponse;

/** Compact 26px buttons (the card sits above the composer; keep it short). */
const btn26 = "h-[26px] px-[10px] text-[12px]";

/** Short verbs for the one-line header; the command follows inline. */
const KIND_SHORT: Record<string, string> = {
  shell: "wants to run",
  edit: "wants to edit",
  tool: "wants to use",
  question: "has a question",
  input: "is waiting for input",
  trust: "asks to trust this folder",
};

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
  // A long command stays on one line until clicked.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [attention.id]);
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

  // Compact, full-width (A-States under the Polish rules): two rows — what
  // the agent wants (with the command inline), then the answers. Warm surface
  // step with a soft amber ring instead of a border.
  const where = worktree ? shortPath(worktree) : null;
  return (
    <section
      role="alertdialog"
      aria-label={`${name} ${KIND_TITLE[attention.kind] ?? "needs you"}`}
      className="mx-[24px] mt-[10px] flex flex-col gap-[8px] rounded-(--radius-card) bg-[color-mix(in_oklab,var(--color-warning)_6%,var(--color-bg-surface))] px-[12px] py-[8px] shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-warning)_32%,transparent)]"
    >
      <header className="flex min-w-0 items-center gap-[8px] text-[12.5px]">
        <ShieldAlert className="size-[13px] shrink-0 text-(--color-warning)" aria-hidden />
        <span className="shrink-0 font-medium text-(--color-warning)">
          {name} {attention.detail ? (KIND_SHORT[attention.kind] ?? "needs you") : (KIND_TITLE[attention.kind] ?? "needs you")}
        </span>
        {attention.detail ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? "Collapse" : attention.detail}
            className={cn(
              "min-w-0 flex-1 rounded-(--radius-control) bg-(--color-bg-input) px-[8px] py-[3px] text-left font-mono text-[12px] text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
              expanded ? "whitespace-pre-wrap break-all" : "truncate",
            )}
          >
            {attention.detail}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-(--color-text-secondary)">{attention.title}</span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-(--color-text-muted)">
          {formatElapsed(attention.since, now)}
        </span>
      </header>
      <div className="flex min-w-0 items-center gap-[6px]">
        {attention.canRespond ? (
          <>
            <Button variant="primary" size="sm" className={btn26} disabled={busy} shortcut="⌘Y" onClick={() => onRespond("allow-once")}>
              {isTrust ? "Trust folder" : "Allow once"}
            </Button>
            {allowForTask && !isTrust ? (
              <Button variant="secondary" size="sm" className={btn26} disabled={busy} onClick={() => onRespond("allow-task")}>
                Allow for this task
              </Button>
            ) : null}
            <Button variant="danger" size="sm" className={btn26} disabled={busy} shortcut="⌘⌫" onClick={() => onRespond("deny")}>
              {isTrust ? "Exit agent" : "Deny"}
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" className={btn26} onClick={onOpenTerminal}>
            Answer in the terminal
          </Button>
        )}
        <span className="min-w-0 flex-1" />
        {where || attention.source === "heuristic" ? (
          <span
            className="min-w-0 truncate text-[11px] text-(--color-text-muted)"
            title={attention.source === "heuristic" ? "Detected from the terminal output; answers press the agent's own keys" : worktree ?? undefined}
          >
            {where ? (
              <>
                in <span className="font-mono">{where}</span>
              </>
            ) : null}
            {attention.source === "heuristic" ? (where ? " · from terminal" : "from terminal") : null}
          </span>
        ) : null}
        {isTrust ? null : (
          <button
            type="button"
            onClick={onChangeDefault}
            className="shrink-0 rounded-(--radius-chip) text-[11px] text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            Change default…
          </button>
        )}
      </div>
    </section>
  );
}

/** `~/.phasr/worktrees/9ffee547…` — home folded, a long id shortened. */
function shortPath(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "$1…");
}
