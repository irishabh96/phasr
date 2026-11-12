import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { VOICE_LEVEL_EVENT, VOICE_PARTIAL_EVENT } from "@/lib/events";
import { humanizeError } from "@/lib/humanizeError";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type { PolisherInfo, VoiceModel } from "@/lib/types";
import { registerHoldTarget } from "./fnHold";
import { insertDictation } from "./insert";
import { activePolisher, activeVoiceModel, useVoicePrefs } from "./prefs";
import { useDictationPolishers, useVoiceModels } from "./useVoiceModels";

/**
 * starting → recording (live text appears in the box) → transcribing (the
 * last words) → polishing (a fast model cleans it up, when on) → idle.
 */
export type DictationPhase = "idle" | "starting" | "recording" | "transcribing" | "polishing";

/** Readings kept for the waveform (50ms each: the last 12 seconds — wider than any box). */
export const LEVEL_HISTORY = 240;
/** Long enough for any prompt; stops (and transcribes) on its own after. */
export const MAX_DICTATION_MS = 5 * 60_000;

const OWNER_EVENT = "phasr:dictation-owner";
let ownerSeq = 0;

export interface Dictation {
  phase: DictationPhase;
  /** Not idle: the box shows the dictation bar, and is read-only (the live text is being written into it). */
  active: boolean;
  /** Cleans up the transcript after (null = off or none installed). */
  polisher: PolisherInfo | null;
  levels: number[];
  startedAt: number | null;
  /** Downloaded model in use; null = none yet (the mic opens setup). */
  model: VoiceModel | null;
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
  /** ⌘⇧D from the host's input. True when it handled the event. */
  onKeyDown: (e: KeyboardEvent) => boolean;
}

/**
 * Dictation into a textarea: the mic records, Whisper transcribes on this
 * Mac, and the text appears live where the caret was (`insertDictation`),
 * replaced by the final text when you stop and then — when a polisher is
 * on — by a fast model's cleanup of it (Esc during cleanup keeps the
 * transcript as heard).
 *
 * While recording, Esc cancels (the box goes back to what it was) and ↵ stops (captured before the box or a
 * dialog sees them). One dictation at a time across the app: starting one
 * here ends any other.
 */
export function useDictation({
  textareaRef,
  value,
  setValue,
  disabled = false,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (next: string) => void;
  disabled?: boolean | undefined;
}): Dictation {
  const owner = useRef(0);
  if (owner.current === 0) owner.current = ++ownerSeq;
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [levels, setLevels] = useState<number[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const { data: models } = useVoiceModels();
  const prefs = useVoicePrefs();
  const model = activeVoiceModel(models, prefs.modelId);
  const { data: polishers } = useDictationPolishers();
  const polisher = activePolisher(prefs.polish, polishers);

  // Latest values for async callbacks.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const valueRef = useRef(value);
  valueRef.current = value;
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;
  /** Bumped by cancel / takeover: an older start or stop result is dropped. */
  const generation = useRef(0);
  const selection = useRef<[number, number]>([0, 0]);
  /** The box's text when dictation started: live text is shown on top of it, and cancel restores it. */
  const base = useRef("");
  const pendingCaret = useRef<number | null>(null);

  /** Show `text` as the dictation (on top of `base`). */
  const show = useCallback((text: string) => {
    const [s, e] = selection.current;
    const next = insertDictation(base.current, s, e, text);
    pendingCaret.current = next.caret;
    setValueRef.current(next.value);
  }, []);

  // Put the caret after the inserted text once it renders.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const el = textareaRef.current;
    if (caret === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [value, textareaRef]);

  const fail = useCallback((err: unknown) => {
    const msg = String(err);
    if (msg.includes("microphone access denied")) {
      showToast({
        intent: "warning",
        title: "Phasr can't use the microphone",
        message: "Allow Phasr in System Settings → Privacy & Security → Microphone.",
        action: { label: "Open System Settings", onClick: () => void tauri.openMicrophoneSettings() },
      });
    } else if (msg.includes("voice model not downloaded")) {
      setSetupOpen(true);
    } else {
      showToast({ intent: "error", title: "Dictation failed", message: humanizeError(err) });
    }
  }, []);

  const start = useCallback(() => {
    if (phaseRef.current !== "idle" || disabled) return;
    if (!model) {
      setSetupOpen(true);
      return;
    }
    const el = textareaRef.current;
    const len = valueRef.current.length;
    selection.current = el ? [el.selectionStart ?? len, el.selectionEnd ?? len] : [len, len];
    base.current = valueRef.current;
    window.dispatchEvent(new CustomEvent(OWNER_EVENT, { detail: owner.current }));
    const gen = ++generation.current;
    // Synchronously too: fn can be let go before the next render.
    phaseRef.current = "starting";
    setPhase("starting");
    setLevels([]);
    const language = model.languages === "multilingual" ? prefs.language : null;
    tauri.startDictation(model.id, language).then(
      () => {
        if (gen !== generation.current) {
          // Cancelled while the mic was opening.
          void tauri.cancelDictation();
          return;
        }
        setStartedAt(Date.now());
        phaseRef.current = "recording";
        setPhase("recording");
      },
      (err) => {
        if (gen !== generation.current) return;
        setPhase("idle");
        fail(err);
      },
    );
  }, [disabled, model, prefs.language, textareaRef, fail]);

  const stop = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    const gen = generation.current;
    phaseRef.current = "transcribing";
    setPhase("transcribing");
    const done = () => {
      setPhase("idle");
      setStartedAt(null);
    };
    tauri.stopDictation().then(
      (raw) => {
        if (gen !== generation.current) return;
        if (!raw.trim()) {
          setValueRef.current(base.current);
          done();
          showToast({ intent: "info", title: "Didn't catch anything", message: "Nothing was heard — check your microphone and try again." });
          return;
        }
        show(raw);
        if (!polisher) {
          done();
          return;
        }
        setPhase("polishing");
        tauri.polishDictation(raw, polisher.id).then(
          (clean) => {
            if (gen !== generation.current) return;
            if (clean.trim()) show(clean);
            done();
          },
          (err) => {
            if (gen !== generation.current) return;
            done();
            showToast({
              intent: "info",
              title: "Kept the transcript as heard",
              message: `${polisher.label} couldn't clean it up: ${humanizeError(err)}`,
            });
          },
        );
      },
      (err) => {
        if (gen !== generation.current) return;
        setValueRef.current(base.current);
        done();
        fail(err);
      },
    );
  }, [polisher, show, fail]);

  /**
   * Esc / ✕. While recording: stop and put the box back as it was. While
   * cleaning up: skip the cleanup and keep the transcript as heard.
   */
  const cancel = useCallback(() => {
    const was = phaseRef.current;
    if (was === "idle") return;
    generation.current++;
    phaseRef.current = "idle";
    setPhase("idle");
    setStartedAt(null);
    if (was !== "polishing") setValueRef.current(base.current);
    if (was === "recording" || was === "starting") void tauri.cancelDictation();
    textareaRef.current?.focus();
  }, [textareaRef]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") start();
    else if (phaseRef.current === "recording") stop();
  }, [start, stop]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!matchShortcut(e, SHORTCUTS.dictate)) return false;
      e.preventDefault();
      toggle();
      return true;
    },
    [toggle],
  );

  // Hold fn to talk into this box (when it's the one you're in).
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const startRef = useRef(start);
  startRef.current = start;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(
    () =>
      registerHoldTarget({
        textarea: () => textareaRef.current,
        disabled: () => !!disabledRef.current,
        phase: () => phaseRef.current,
        start: () => startRef.current(),
        release: () => {
          // Let go before the mic opened: nothing was heard.
          if (phaseRef.current === "starting") cancelRef.current();
          else if (phaseRef.current === "recording") stopRef.current();
        },
      }),
    [textareaRef],
  );

  // Another box started dictating: the backend already dropped ours.
  useEffect(() => {
    const onOwner = (e: Event) => {
      if ((e as CustomEvent<number>).detail === owner.current || phaseRef.current === "idle") return;
      if (phaseRef.current !== "polishing") setValueRef.current(base.current);
      generation.current++;
      setPhase("idle");
      setStartedAt(null);
    };
    window.addEventListener(OWNER_EVENT, onOwner);
    return () => window.removeEventListener(OWNER_EVENT, onOwner);
  }, []);

  // Going away mid-sentence closes the mic.
  useEffect(
    () => () => {
      const p = phaseRef.current;
      if (p === "recording" || p === "starting") void tauri.cancelDictation();
    },
    [],
  );

  // The meter.
  useEffect(() => {
    if (phase !== "recording") return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<{ level: number }>(VOICE_LEVEL_EVENT, ({ payload }) => {
      setLevels((prev) => {
        const next = prev.length >= LEVEL_HISTORY ? prev.slice(prev.length - LEVEL_HISTORY + 1) : prev.slice();
        next.push(payload.level);
        return next;
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    let unlistenPartial: (() => void) | null = null;
    const gen = generation.current;
    void listen<{ text: string }>(VOICE_PARTIAL_EVENT, ({ payload }) => {
      if (gen === generation.current && phaseRef.current === "recording") show(payload.text);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenPartial = fn;
    });
    const limit = window.setTimeout(stop, MAX_DICTATION_MS);
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenPartial?.();
      window.clearTimeout(limit);
    };
  }, [phase, stop, show]);

  // Esc cancels and ↵ (with or without ⌘) stops — before the textarea
  // (newline / send) or an enclosing dialog (close) can act on them.
  useEffect(() => {
    if (phase === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        stop();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, cancel, stop]);

  return {
    phase,
    active: phase !== "idle",
    polisher,
    levels,
    startedAt,
    model,
    setupOpen,
    setSetupOpen,
    start,
    stop,
    cancel,
    toggle,
    onKeyDown,
  };
}
