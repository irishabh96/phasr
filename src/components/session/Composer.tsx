import { ArrowUp } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { AGENT_META } from "@/components/ui/AgentMark";
import { tauri } from "@/lib/tauri";
import type { Agent } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { humanizeError, isAwaitingAnswerError } from "@/lib/humanizeError";

/**
 * Reply box under the agent's terminal (A-Workspace "Composer"). Sends via
 * `send_message_to_task`: one bracketed paste (control bytes stripped) then
 * Enter, so newlines don't submit early and pasted text can't act as keys.
 *
 * FIXED HEIGHT from the first render: the terminal above sizes itself from
 * the space left over and an agent TUI reads its size once at startup, so
 * this box must never appear late or grow.
 */
export function Composer({
  taskId,
  agent,
  disabled,
  awaitingAnswer = false,
}: {
  taskId: string;
  agent: Agent | null;
  disabled?: boolean;
  /**
   * The agent is paused on a permission dialog. Its Enter would pick the
   * highlighted option ("Yes"), so a message — even the "Continue" chip —
   * would approve the command. The box keeps its height (the terminal
   * above must not resize) but only points at the request.
   */
  awaitingAnswer?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const name = agent ? AGENT_META[agent].label : "the agent";

  const send = async (body: string) => {
    const message = body.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      // The backend frames it as one bracketed paste with control bytes
      // stripped, presses Enter after the paste settles, and refuses once
      // the agent has exited (so text never lands in a bare shell).
      await tauri.sendMessageToTask(taskId, message, true);
      setText("");
    } catch (err) {
      showToast(
        isAwaitingAnswerError(err)
          ? { intent: "info", title: `${name} is waiting for your answer`, message: "Answer the request above, then send your message." }
          : String(err).includes("agent not running")
            ? { intent: "warning", title: `${name} isn't running`, message: "Open the agent tab to resume it." }
            : { intent: "error", title: `Couldn't send to ${name}`, message: humanizeError(err) },
      );
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  if (awaitingAnswer) {
    return (
      <div className="shrink-0 px-[18px] pb-3.5 pt-2">
        <div
          role="status"
          className="flex h-[84px] items-center justify-center rounded-(--radius-card) border border-dashed border-(--color-border-default) px-3 text-[12px] text-(--color-text-muted)"
        >
          Answer the request above to continue messaging {name}.
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-[18px] pb-3.5 pt-2">
      <div className="flex h-[84px] flex-col gap-2 rounded-(--radius-card) border border-(--color-accent-900) bg-(--color-bg-sidebar) px-3 py-2.5 focus-within:border-(--color-accent-700)">
        <label htmlFor={`composer-${taskId}`} className="sr-only">
          Message {name}
        </label>
        <textarea
          id={`composer-${taskId}`}
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Reply to ${name}… (↵ send · ⇧↵ newline)`}
          className="min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-[13px] leading-[1.45] text-(--color-text-primary) shadow-none outline-none placeholder:text-(--color-text-muted) focus:shadow-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5">
          {["Continue", "Run the tests"].map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={disabled || sending}
              onClick={() => void send(chip)}
              className="h-[26px] rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-surface) px-2.5 text-[12px] text-(--color-text-primary) hover:border-(--color-border-strong) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
            >
              {chip}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Send"
            disabled={disabled || sending || !text.trim()}
            onClick={() => void send(text)}
            className="grid size-[26px] place-items-center rounded-(--radius-control) bg-(--color-accent-500) text-(--color-accent-onfill) hover:bg-(--color-accent-400) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <ArrowUp className="size-3.5" strokeWidth={2.5} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
