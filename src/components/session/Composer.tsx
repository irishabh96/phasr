import { ArrowUp } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AGENT_META } from "@/components/ui/AgentMark";
import { tauri } from "@/lib/tauri";
import type { Agent } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { humanizeError, isAwaitingAnswerError } from "@/lib/humanizeError";
import { cn } from "@/lib/utils";

/** One line of the 13.5px / 1.45 input. */
const LINE_PX = 19.5;
/** Vertical padding, so one line sits in A-Workspace's 25px input box. */
const PAD_Y = 3;
/** The input grows to this many lines, then scrolls. */
const MAX_LINES = 6;
const MIN_H = LINE_PX + PAD_Y * 2;
const MAX_H = LINE_PX * MAX_LINES + PAD_Y * 2;

/** ⌘↵ (Ctrl+↵ off macOS) sends; a bare Enter is a newline (spec D8). */
export function isSendChord(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/**
 * Reply box under the agent's terminal (A-Workspace "Composer"). Sends via
 * `send_message_to_task`: one bracketed paste (control bytes stripped) then
 * Enter, so newlines don't submit early and pasted text can't act as keys.
 *
 * ⌘↵ sends, Enter inserts a newline (D8). The input starts on one line and
 * grows to about six.
 *
 * FIXED FOOTPRINT from the first render: the terminal above sizes itself
 * from the space left over and an agent TUI reads its size once at startup,
 * so this box must never appear late or change the column's layout. The
 * slot keeps its height; a growing input lifts the surface upward over the
 * bottom of the terminal instead of pushing it.
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

  // Auto-grow: measure the content, clamp to MAX_LINES. Layout effect so the
  // first paint after a keystroke already has the new height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    // scrollHeight includes the padding.
    const h = Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > MAX_H + 1 ? "auto" : "hidden";
  }, [text, awaitingAnswer]);

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
    if (e.nativeEvent.isComposing) return;
    if (isSendChord(e)) {
      e.preventDefault();
      void send(text);
    }
    // A bare Enter falls through: the textarea inserts the newline.
  };

  // The slot: fixed height in the column. The surface is anchored to its
  // bottom, so growth spills upward without moving anything else.
  const slot = "relative h-[114px] shrink-0";
  const surface =
    "absolute inset-x-[24px] bottom-[16px] z-10 flex min-h-[86px] flex-col gap-[10px] rounded-[10px] bg-(--color-bg-surface) px-[14px] py-[12px] shadow-(--shadow-composer)";

  if (awaitingAnswer) {
    return (
      <div className={slot}>
        <div role="status" className={cn(surface, "justify-center opacity-75")}>
          <span className="text-[13px] text-(--color-text-muted)">
            Answer the request above to continue messaging {name}.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={slot}>
      <div className={surface}>
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
          placeholder={`Reply to ${name}…`}
          aria-keyshortcuts="Meta+Enter"
          style={{ height: MIN_H, paddingTop: PAD_Y, paddingBottom: PAD_Y }}
          className="block w-full resize-none overflow-hidden border-0 bg-transparent px-0 text-[13.5px] leading-[1.45] text-(--color-text-primary) shadow-none outline-none placeholder:text-(--color-text-muted) focus:shadow-none disabled:opacity-50"
        />
        <div className="flex items-center gap-[6px]">
          {["Continue", "Run the tests"].map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={disabled || sending}
              onClick={() => void send(chip)}
              className="h-[26px] rounded-(--radius-control) bg-(--color-bg-elevated) px-[10px] text-[12px] text-(--color-text-secondary) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
            >
              {chip}
            </button>
          ))}
          <span className="flex-1" />
          <span aria-hidden className="text-[11px] text-(--color-text-muted)">
            ⌘↵ send
          </span>
          <button
            type="button"
            aria-label="Send"
            aria-keyshortcuts="Meta+Enter"
            disabled={disabled || sending || !text.trim()}
            onClick={() => void send(text)}
            className="ml-[4px] grid size-[26px] place-items-center rounded-(--radius-control) bg-(--color-accent-500) text-(--color-accent-onfill) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-accent-400) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <ArrowUp className="size-[13px]" strokeWidth={2.5} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
