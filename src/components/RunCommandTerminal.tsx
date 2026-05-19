import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { tauri } from "@/lib/tauri";
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
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const term = createTerminal();
    const fit = new FitAddon();
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
        await tauri.startRunCommand(runCommandId, channel, term.rows, term.cols);
        if (cancelled) return;
        disposables.push(
          term.onData((data) => {
            if (cancelled) return;
            void tauri.sendRunCommandInput(runCommandId, data).catch(() => {});
          }),
          term.onResize(({ rows, cols }) => {
            if (cancelled) return;
            void tauri.resizeRunCommand(runCommandId, rows, cols).catch(() => {});
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
    };
  }, [runCommandId]);

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

function createTerminal() {
  const computed = getComputedStyle(document.documentElement);
  const css = (name: string, fallback: string) =>
    computed.getPropertyValue(name).trim() || fallback;
  return new XtermTerminal({
    fontFamily: css("--font-mono", "ui-monospace, Menlo, monospace"),
    fontSize: 13,
    lineHeight: 1.0,
    cursorBlink: true,
    convertEol: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: {
      background: css("--color-bg-terminal", "#000000"),
      foreground: css("--color-text-primary", "#e6edf3"),
      cursor: css("--color-accent-500", "#f78166"),
      selectionBackground: "rgba(247,129,102,0.28)",
      black: css("--ansi-black", "#484f58"),
      red: css("--ansi-red", "#ff7b72"),
      green: css("--ansi-green", "#3fb950"),
      yellow: css("--ansi-yellow", "#d29922"),
      blue: css("--ansi-blue", "#58a6ff"),
      magenta: css("--ansi-magenta", "#bc8cff"),
      cyan: css("--ansi-cyan", "#39c5cf"),
      white: css("--ansi-white", "#b1bac4"),
      brightBlack: css("--ansi-bright-black", "#6e7681"),
      brightRed: css("--ansi-bright-red", "#ffa198"),
      brightGreen: css("--ansi-bright-green", "#56d364"),
      brightYellow: css("--ansi-bright-yellow", "#e3b341"),
      brightBlue: css("--ansi-bright-blue", "#79c0ff"),
      brightMagenta: css("--ansi-bright-magenta", "#d2a8ff"),
      brightCyan: css("--ansi-bright-cyan", "#56d4dd"),
      brightWhite: css("--ansi-bright-white", "#ffffff"),
    },
  });
}
