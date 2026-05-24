import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { tauri } from "@/lib/tauri";
import { applyXtermSettings, createXtermTerminal } from "@/lib/terminal/xterm";
import type { PtyEvent } from "@/lib/types";

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
  const { data: settings } = useUserSettings();
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const term = createXtermTerminal();
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
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
        term.write(
          `\r\n\x1b[2m── exited${
            event.exitCode == null ? "" : ` (code ${event.exitCode})`
          } ──\x1b[0m\r\n`,
        );
        onExitRef.current?.(event.exitCode);
      }
    };

    const start = async () => {
      term.write("\x1b[2m── starting ──\x1b[0m\r\n");
      try {
        await tauri.startRunCommand(
          runCommandId,
          channel,
          term.rows,
          term.cols,
        );
        if (cancelled) return;
        disposables.push(
          term.onData((data) => {
            if (cancelled) return;
            void tauri.sendRunCommandInput(runCommandId, data).catch(() => {});
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
        term.write(`\r\n\x1b[31m✗ Failed to start: ${String(err)}\x1b[0m\r\n`);
      }
    };

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
        paddingTop: 10,
        paddingRight: 8,
        paddingBottom: 2,
        paddingLeft: 16,
      }}
      className="h-full min-h-0 w-full overflow-hidden bg-(--color-bg-terminal)"
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
