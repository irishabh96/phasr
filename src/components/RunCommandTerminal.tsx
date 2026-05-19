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
      } catch {
        /* layout settling */
      }
    };
    requestAnimationFrame(fitNow);

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
        paddingBottom: 16,
        paddingLeft: 16,
      }}
      className="h-full min-h-0 w-full overflow-hidden bg-(--color-bg-input)"
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

function createTerminal() {
  const computed = getComputedStyle(document.documentElement);
  return new XtermTerminal({
    fontFamily: computed.getPropertyValue("--font-mono").trim() || "JetBrains Mono",
    fontSize: 13,
    cursorBlink: true,
    convertEol: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: {
      background: computed.getPropertyValue("--color-bg-input").trim() || "#0e0e11",
      foreground: computed.getPropertyValue("--color-text-primary").trim() || "#e8e8ec",
      cursor: computed.getPropertyValue("--color-accent-500").trim() || "#6366f1",
      selectionBackground: "#3a3a45",
    },
  });
}
