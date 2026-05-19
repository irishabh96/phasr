import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { tauri } from "@/lib/tauri";
import type { PtyEvent, WorkspaceStatus } from "@/lib/types";

export interface TerminalProps {
  workspaceId: string;
  /** Snapshot of status at the moment the user opened the workspace. */
  status: WorkspaceStatus;
  onExit?: (exitCode: number | null) => void;
}

const FINISHED_STATUSES: WorkspaceStatus[] = ["completed", "failed", "archived"];

export function Terminal({ workspaceId, status, onExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initialStatusRef = useRef(status);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialStatus = initialStatusRef.current;
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
        // Force WebGL renderer to repaint immediately at the new dimensions.
        // Without this, the canvas keeps its old pixel size for ~1 frame
        // after resize, and the wrapper's overflow-hidden clips text near
        // the right edge — visible as "text hiding" when sidebars open.
        if (term.rows > 0) term.refresh(0, term.rows - 1);
      } catch {
        /* layout still settling */
      }
    };
    // Fit synchronously so term.rows/term.cols reflect the real container
    // size before startWorkspace reads them. Otherwise the PTY spawns at
    // xterm's default 24x80 and TUIs (Codex, Claude CLI) lay out for that
    // size — leaving the rest of the visible area unused.
    fitNow();
    term.focus();

    const resizeObserver = new ResizeObserver(fitNow);
    resizeObserver.observe(container);

    const disposables: { dispose(): void }[] = [];

    const wireInteractive = () => {
      disposables.push(
        term.onData((data) => {
          if (cancelled) return;
          void tauri.sendWorkspaceInput(workspaceId, data).catch((err) => {
            term.write(`\r\n\x1b[31m[input error: ${String(err)}]\x1b[0m\r\n`);
          });
        }),
      );
      disposables.push(
        term.onResize(({ rows, cols }) => {
          if (cancelled) return;
          void tauri.resizeWorkspace(workspaceId, rows, cols).catch(() => {});
        }),
      );
      term.focus();
    };

    const startOrAttach = async () => {
      term.write("\x1b[2m── starting workspace ──\x1b[0m\r\n");
      const channel = new Channel<PtyEvent>();
      channel.onmessage = (event) => {
        if (cancelled) return;
        if (event.type === "output") {
          term.write(event.chunk);
        } else if (event.type === "exit") {
          term.write(
            `\r\n\x1b[2m── process exited${
              event.exitCode == null ? "" : ` (code ${event.exitCode})`
            } ──\x1b[0m\r\n`,
          );
          onExitRef.current?.(event.exitCode);
        }
      };
      try {
        await tauri.startWorkspace(workspaceId, channel, term.rows, term.cols);
        if (cancelled) return;
        wireInteractive();
      } catch (err) {
        if (cancelled) return;
        term.write(`\r\n\x1b[31m✗ Failed to start: ${String(err)}\x1b[0m\r\n`);
      }
    };

    const loadLog = async () => {
      try {
        const log = await tauri.readWorkspaceLog(workspaceId);
        if (cancelled) return;
        term.write(log.length > 0 ? log : "\x1b[2m(no log output)\x1b[0m\r\n");
      } catch (err) {
        if (cancelled) return;
        term.write(`\r\n\x1b[31mFailed to load log: ${String(err)}\x1b[0m\r\n`);
      }
    };

    if (FINISHED_STATUSES.includes(initialStatus)) {
      void loadLog();
    } else {
      void startOrAttach();
    }

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      for (const d of disposables) d.dispose();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  return (
    <div
      onClick={() => {
        const buf = containerRef.current?.querySelector("textarea");
        (buf as HTMLTextAreaElement | null)?.focus();
      }}
      className="h-full min-h-0 w-full overflow-hidden bg-(--color-bg-terminal)"
      style={{
        paddingTop: 10,
        paddingRight: 8,
        paddingBottom: 2,
        paddingLeft: 16,
      }}
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
