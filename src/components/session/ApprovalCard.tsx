import { ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { formatElapsed } from "@/lib/board";
import { useNow } from "@/lib/hooks/useNow";
import type { Agent, Attention, AttentionResponse } from "@/lib/types";

type ApprovalAttention = Attention;
type ApprovalResponse = AttentionResponse;

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

  // ⌘Y allow once, ⌘⌫ deny — only while focus isn't in an editable field
  // (⌘⌫ there is "delete to line start").
  useEffect(() => {
    if (!attention.canRespond) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const editable = !!t?.closest("input, textarea, select, [contenteditable='true']");
      if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onRespond("allow-once");
      } else if (e.key === "Backspace" && !editable) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onRespond("deny");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [attention.canRespond, attention.id, onRespond]);

  return (
    <section
      role="alertdialog"
      aria-label={`${name} ${KIND_TITLE[attention.kind] ?? "needs you"}`}
      className="mx-[18px] mt-2 flex flex-col gap-2.5 rounded-(--radius-card) border border-(--color-warning) bg-(--color-warning-tint) p-3"
    >
      <header className="flex items-center gap-2 text-[13px]">
        <ShieldAlert className="size-4 shrink-0 text-(--color-warning)" aria-hidden />
        <span className="font-medium">
          {name} {KIND_TITLE[attention.kind] ?? "needs you"}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-(--color-warning)">waiting {formatElapsed(attention.since, now)}</span>
      </header>
      {attention.detail ? (
        <code className="block overflow-x-auto whitespace-pre rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-base) px-2.5 py-2 font-mono text-[12px] text-(--color-text-primary)">
          {attention.detail}
        </code>
      ) : (
        <p className="m-0 text-[12px] text-(--color-text-secondary)">{attention.title}</p>
      )}
      {worktree ? (
        <span className="text-[11px] text-(--color-text-muted)">
          in <span className="font-mono">{worktree.replace(/^\/Users\/[^/]+/, "~")}</span>
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {attention.canRespond ? (
          <>
            <Button variant="primary" size="sm" disabled={busy} shortcut="⌘Y" onClick={() => onRespond("allow-once")}>
              {isTrust ? "Trust folder" : "Allow once"}
            </Button>
            {allowForTask && !isTrust ? (
              <Button size="sm" disabled={busy} onClick={() => onRespond("allow-task")}>
                Allow for this task
              </Button>
            ) : null}
            <Button variant="danger" size="sm" disabled={busy} shortcut="⌘⌫" onClick={() => onRespond("deny")}>
              {isTrust ? "Exit agent" : "Deny"}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onOpenTerminal}>
            Answer in the terminal
          </Button>
        )}
        <span className="flex-1" />
        {isTrust ? null : <button
          type="button"
          onClick={onChangeDefault}
          className="text-[11px] text-(--color-text-muted) underline-offset-2 hover:text-(--color-text-secondary) hover:underline focus-visible:outline-none focus-visible:underline"
        >
          Change default…
        </button>}
      </div>
      {attention.source === "heuristic" ? (
        <span className="text-[11px] text-(--color-text-muted)">
          Detected from the terminal output · <Kbd tone="bare">answers press the agent&apos;s own keys</Kbd>
        </span>
      ) : null}
    </section>
  );
}
