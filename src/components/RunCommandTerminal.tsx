import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { TerminalStatus } from "@/components/TerminalStatus";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { tauri } from "@/lib/tauri";
import { installTerminalLinks } from "@/lib/terminal/links";
import { applyXtermSettings, createXtermTerminal } from "@/lib/terminal/xterm";
import type { PtyEvent } from "@/lib/types";

type StartMode = "initial" | "retry" | "restart";

/** Overlay state driven onto <TerminalStatus>. `null` = no overlay. */
type TermStatus =
  | { state: "starting" | "retrying" | "restarting" }
  | { state: "failed"; error: string }
  | { state: "exited"; exitCode: number | null }
  | null;

interface RunCommandTerminalProps {
  /** Run command id (NOT a workspace id). */
  runCommandId: string;
  visible: boolean;
  onExit?: (exitCode: number | null) => void;
}

/**
 * xterm.js terminal wired to a Phasr run-command PTY. Built on the same
 * pattern as the workspace `<Terminal>` but talks to the run-command
 * tauri commands (which key PTYs under `run:<id>` so they coexist with
 * workspace PTYs).
 *
 * Renders even when hidden so the PTY connection survives tab switches;
 * a parent simply toggles its container's display.
 */
export function RunCommandTerminal({
  runCommandId,
  visible,
  onExit,
}: RunCommandTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  const termRef = useRef<ReturnType<typeof createXtermTerminal> | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<TermStatus>(null);
  const retryStartRef = useRef<(() => void) | null>(null);
  const restartRef = useRef<(() => void) | null>(null);
  const { data: settings } = useUserSettings();
  onExitRef.current = onExit;
  const editorIdRef = useRef<string | null>(null);
  editorIdRef.current = settings?.defaultEditor ?? null;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    // Born at the user's font size — see Terminal.tsx for why.
    const term = createXtermTerminal(settingsRef.current);
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    // No cwd context on this surface — URL + absolute-path links only.
    installTerminalLinks(term, {
      getCwd: () => null,
      getEditorId: () => editorIdRef.current,
    });
    term.open(container);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* canvas fallback */
    }

    const fitNow = () => {
      try {
        fit.fit();
        if (term.rows > 0) term.refresh(0, term.rows - 1);
      } catch {
        /* layout settling */
      }
    };
    // Fit synchronously so startRunCommand receives real rows/cols rather
    // than xterm's default 24x80 — see Terminal.tsx for context.
    fitNow();

    const resizeObserver = new ResizeObserver(fitNow);
    resizeObserver.observe(container);

    const disposables: { dispose(): void }[] = [];

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      if (event.type === "output") {
        term.write(event.chunk);
      } else if (event.type === "exit") {
        setStatus({ state: "exited", exitCode: event.exitCode });
        onExitRef.current?.(event.exitCode);
      }
    };

    const start = async (mode: StartMode = "initial") => {
      setStatus(
        mode === "retry"
          ? { state: "retrying" }
          : mode === "restart"
            ? { state: "restarting" }
            : { state: "starting" },
      );
      for (const d of disposables.splice(0)) d.dispose();
      try {
        await tauri.startRunCommand(
          runCommandId,
          channel,
          term.rows,
          term.cols,
        );
        if (cancelled) return;
        setStatus(null);
        disposables.push(
          term.onData((data) => {
            if (cancelled) return;
            void tauri.sendRunCommandInput(runCommandId, data).catch((err) => {
              if (cancelled) return;
              setStatus({ state: "failed", error: String(err) });
            });
          }),
          term.onResize(({ rows, cols }) => {
            if (cancelled) return;
            void tauri
              .resizeRunCommand(runCommandId, rows, cols)
              .catch(() => {});
          }),
        );
        term.focus();
      } catch (err) {
        if (cancelled) return;
        setStatus({ state: "failed", error: String(err) });
      }
    };
    retryStartRef.current = () => void start("retry");
    restartRef.current = () => void start("restart");

    void start();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      for (const d of disposables) d.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [runCommandId]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    applyXtermSettings(term, settings);
    try {
      fit.fit();
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    } catch {
      /* layout settling */
    }
  }, [settings]);

  return (
    <div
      onClick={() => {
        const buf = containerRef.current?.querySelector("textarea");
        (buf as HTMLTextAreaElement | null)?.focus();
      }}
      style={{
        display: visible ? "block" : "none",
        paddingTop: 8,
        paddingRight: 8,
        paddingBottom: 4,
        paddingLeft: 16,
      }}
      className="relative h-full min-h-0 w-full overflow-hidden bg-(--color-bg-terminal)"
    >
      <div ref={containerRef} className="h-full w-full" />
      {status && (
        <TerminalStatus
          state={status.state}
          {...(status.state === "failed" ? { error: status.error } : {})}
          {...(status.state === "exited" ? { exitCode: status.exitCode } : {})}
          onRetry={() => retryStartRef.current?.()}
          onRestart={() => restartRef.current?.()}
        />
      )}
    </div>
  );
}
