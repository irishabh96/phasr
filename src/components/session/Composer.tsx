import { ArrowUp, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AttachIconButton, AttachmentChips } from "@/components/attachments/Attachments";
import { AGENT_META } from "@/components/ui/AgentMark";
import { DictationBar } from "@/components/voice/DictationBar";
import { DictationButton, MicSlotButton } from "@/components/voice/DictationButton";
import { withAttachmentBlock } from "@/lib/attachments";
import { useAttachments } from "@/lib/hooks/useAttachments";
import { tauri } from "@/lib/tauri";
import { enqueue, mustQueue, shouldFlush, useQueuedMessage } from "@/lib/transcript/sendQueue";
import type { ReplySuggestions } from "@/lib/transcript/useReplySuggestions";
import type { Agent, TaskAgentState } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { humanizeError, isAwaitingAnswerError } from "@/lib/humanizeError";
import { cn } from "@/lib/utils";
import { useDictation } from "@/lib/voice/useDictation";

/** One line of the 13.5px / 1.45 input. */
const LINE_PX = 19.5;
/** Vertical padding, so one line sits in A-Workspace's 25px input box. */
const PAD_Y = 3;
/** The input grows to this many lines, then scrolls. */
const MAX_LINES = 6;
const MIN_H = LINE_PX + PAD_Y * 2;
const MAX_H = LINE_PX * MAX_LINES + PAD_Y * 2;

/** A-Workspace's chip: filled, raised, 26px, 12px text. */
const CHIP =
  "h-[26px] rounded-(--radius-control) bg-(--color-bg-elevated) px-[10px] text-[12px] text-(--color-text-secondary) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus)";

/** The send / mic / stop buttons: 26px, filled. */
const SLOT =
  "ml-[4px] grid size-[26px] shrink-0 place-items-center rounded-(--radius-control) transition-colors duration-(--dur-1) ease-(--ease-out) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus)";

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
 * bottom of the terminal instead of pushing it, attachment chips included.
 *
 * Attachments (the paperclip, a pasted screenshot, or files dropped on the
 * box) ride along as an "Attached files:" block under the message.
 *
 * The send button is a mic while the box is empty (or ⌘⇧D): while you
 * talk the controls row becomes the dictation bar (same height), and the
 * text lands at the caret, turning the mic into Send.
 */
export function Composer({
  taskId,
  agent,
  disabled,
  awaitingAnswer = false,
  roots,
  turn,
  suggestions,
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
  /** The task's worktree and repository: attachments inside them are sent
   *  as relative paths. */
  roots?: readonly (string | null | undefined)[];
  /**
   * Transcript view (spec §3): the composer is the only input, so it owns
   * the turn. While the agent works the send button is Stop (`onStop`
   * interrupts the turn) and a message sent meanwhile waits as "Queued"
   * until the turn ends. Absent in terminal view, which keeps today's
   * behaviour exactly.
   */
  turn?: { state: TaskAgentState["state"] | null; onStop: () => Promise<unknown> };
  /**
   * Transcript view's chips: replies the last turn suggests
   * (`useReplySuggestions`) instead of the static "Continue" / "Run the
   * tests". A chip only fills the input — ⌘↵ sends — so a stray click
   * never reaches the agent. Hidden while typing and while a turn runs.
   */
  suggestions?: ReplySuggestions;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queued, setQueued] = useQueuedMessage(taskId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  /** A chip filled the input: put the caret after its text once it renders. */
  const caretToEnd = useRef(false);
  const attachments = useAttachments({ dropRef: surfaceRef });
  const dictation = useDictation({ textareaRef: ref, value: text, setValue: setText, disabled });
  const name = agent ? AGENT_META[agent].label : "the agent";
  const working = !!turn && mustQueue(turn.state);
  const hasContent = text.trim() !== "" || attachments.items.length > 0;
  const turnState = turn ? turn.state : undefined;
  // They clear once you type and come back when the input is empty again.
  const showReplies = !!turn && !working && text === "";
  const replies = showReplies ? (suggestions?.chips ?? []) : [];
  const shimmer = showReplies && !!suggestions?.pending && replies.length === 0;

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

  useLayoutEffect(() => {
    const el = ref.current;
    if (!caretToEnd.current || !el) return;
    caretToEnd.current = false;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [text]);

  /** A suggestion chip: into the input to edit or send, never sent by itself. */
  const fill = (reply: string) => {
    caretToEnd.current = true;
    setText(reply);
  };

  const sendFailed = (err: unknown) =>
    showToast(
      isAwaitingAnswerError(err)
        ? { intent: "info", title: `${name} is waiting for your answer`, message: "Answer the request above, then send your message." }
        : String(err).includes("agent not running")
          ? { intent: "warning", title: `${name} isn't running`, message: "Open the agent tab to resume it." }
          : { intent: "error", title: `Couldn't send to ${name}`, message: humanizeError(err) },
    );

  const send = async (body: string) => {
    const message = withAttachmentBlock(body.trim(), attachments.items, roots);
    if (!message || sending) return;
    if (working) {
      // Transcript view mid-turn: hold it until the turn ends.
      setQueued(enqueue(queued, message));
      setText("");
      attachments.clear();
      ref.current?.focus();
      return;
    }
    setSending(true);
    try {
      // The backend frames it as one bracketed paste with control bytes
      // stripped, presses Enter after the paste settles, and refuses once
      // the agent has exited (so text never lands in a bare shell).
      await tauri.sendMessageToTask(taskId, message, true);
      setText("");
      attachments.clear();
    } catch (err) {
      sendFailed(err);
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  // The turn ended: the queued message goes. If it's refused, it comes
  // back into the input (when that's empty) rather than being lost.
  useEffect(() => {
    if (turnState === undefined || !shouldFlush(queued, turnState, sending)) return;
    const message = queued!;
    setQueued(null);
    setSending(true);
    tauri
      .sendMessageToTask(taskId, message, true)
      .catch((err) => {
        sendFailed(err);
        setText((t) => (t.trim() ? t : message));
      })
      .finally(() => setSending(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendFailed is a fresh closure each render
  }, [queued, turnState, sending, taskId, setQueued]);

  const stop = async () => {
    if (!turn || stopping) return;
    setStopping(true);
    try {
      await turn.onStop();
    } catch (err) {
      showToast({ intent: "error", title: `Couldn't stop ${name}`, message: humanizeError(err) });
    } finally {
      setStopping(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (dictation.onKeyDown(e.nativeEvent)) return;
    if (isSendChord(e)) {
      e.preventDefault();
      void send(text);
    }
    // Tab from the empty input goes to the first suggestion.
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && replies.length) {
      const first = chipsRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
    // A bare Enter falls through: the textarea inserts the newline.
  };

  // Terminal view — the slot: fixed height in the column. The surface is
  // anchored to its bottom, so growth spills upward without moving anything
  // else. Transcript view has no TUI to protect, so the composer takes the
  // room it needs (same 114px at rest) and the transcript above shrinks
  // instead of being covered.
  const slot = turn ? "shrink-0 px-[24px] pb-[16px] pt-[12px]" : "relative h-[114px] shrink-0";
  const surface = cn(
    "flex min-h-[86px] flex-col gap-[10px] rounded-[10px] bg-(--color-bg-surface) px-[14px] py-[12px] shadow-(--shadow-composer)",
    !turn && "absolute inset-x-[24px] bottom-[16px] z-10",
  );

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
      <div ref={surfaceRef} className={surface}>
        {queued ? (
          <div role="status" aria-label="Queued message" className="flex min-w-0 items-center gap-[8px] text-[12px]">
            <span className="shrink-0 rounded-(--radius-chip) bg-(--color-bg-elevated) px-[6px] text-[11px] font-medium leading-[18px] text-(--color-text-secondary)">
              Queued
            </span>
            <span className="min-w-0 flex-1 truncate text-(--color-text-muted)">{queued.replace(/\s+/g, " ")}</span>
            <button
              type="button"
              aria-label="Cancel queued message"
              title="Cancel (puts it back in the box)"
              onClick={() => {
                setQueued(null);
                setText((t) => (t.trim() ? t : queued));
                ref.current?.focus();
              }}
              className="grid size-[18px] shrink-0 place-items-center rounded-(--radius-chip) text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
            >
              <X className="size-[12px]" aria-hidden />
            </button>
          </div>
        ) : null}
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
        <label htmlFor={`composer-${taskId}`} className="sr-only">
          Message {name}
        </label>
        <textarea
          id={`composer-${taskId}`}
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          // The live transcript is being written here while dictating.
          readOnly={dictation.active}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={attachments.onPaste}
          placeholder={`Reply to ${name}…`}
          aria-keyshortcuts="Meta+Enter"
          style={{ height: MIN_H, paddingTop: PAD_Y, paddingBottom: PAD_Y }}
          className="block w-full resize-none overflow-hidden border-0 bg-transparent px-0 text-[13.5px] leading-[1.45] text-(--color-text-primary) shadow-none outline-none placeholder:text-(--color-text-muted) focus:shadow-none disabled:opacity-50"
        />
        {/* Fixed 26px row: chips coming, going or being replaced never move the input.
            While dictating, the dictation bar takes the whole row. */}
        <div className="flex h-[26px] items-center gap-[6px]">
          {dictation.active ? (
            <DictationBar dictation={dictation} />
          ) : (
            <>
              {turn ? (
                <div
                  ref={chipsRef}
                  role="group"
                  aria-label="Suggested replies"
                  data-testid="reply-suggestions"
                  aria-busy={shimmer || undefined}
                  className="flex h-full min-w-0 flex-1 items-center gap-[6px] overflow-hidden"
                >
                  {replies.map((reply) => (
                    <button
                      key={reply.label}
                      type="button"
                      title={reply.text}
                      data-suggestion-source={reply.source}
                      disabled={disabled || sending}
                      onClick={() => fill(reply.text)}
                      className={cn(CHIP, "min-w-0 max-w-[260px] shrink truncate")}
                    >
                      {reply.label}
                    </button>
                  ))}
                  {shimmer ? (
                    <span
                      aria-hidden
                      data-suggestion-shimmer
                      className="skeleton-bar h-[26px] w-[132px] shrink-0 rounded-(--radius-control) bg-(--color-bg-elevated) animate-[pulse-skeleton_1.4s_ease-in-out_infinite]"
                    />
                  ) : null}
                </div>
              ) : (
                <>
                  {["Continue", "Run the tests"].map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      disabled={disabled || sending}
                      onClick={() => void send(chip)}
                      className={CHIP}
                    >
                      {chip}
                    </button>
                  ))}
                  <span className="flex-1" />
                </>
              )}
              <AttachIconButton disabled={disabled} onClick={() => void attachments.pick()} />
              {/* One primary slot: the mic while the box is empty, Send
                  (Queue mid-turn) once there's something to send. ⌘↵ sends
                  either way. Mid-turn, Stop stays beside it. */}
              {hasContent ? (
                <button
                  type="button"
                  aria-label={working ? "Queue message" : "Send"}
                  title={working ? "Queue for when the turn ends (⌘↵)" : "Send (⌘↵)"}
                  aria-keyshortcuts="Meta+Enter"
                  disabled={disabled || sending}
                  onClick={() => void send(text)}
                  className={cn(SLOT, "bg-(--color-accent-500) text-(--color-accent-onfill) hover:bg-(--color-accent-400)")}
                >
                  <ArrowUp className="size-[13px]" strokeWidth={2.5} aria-hidden />
                </button>
              ) : (
                <DictationButton dictation={dictation}>
                  <MicSlotButton disabled={disabled} onClick={dictation.start} className={SLOT} />
                </DictationButton>
              )}
              {working ? (
                <button
                  type="button"
                  aria-label="Stop turn"
                  title={`Stop this turn (${name} keeps the session)`}
                  disabled={stopping}
                  onClick={() => void stop()}
                  className={cn(SLOT, "bg-(--color-bg-elevated) text-(--color-text-primary) hover:bg-(--color-bg-hover)")}
                >
                  <Square className="size-[10px] fill-current" aria-hidden />
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
