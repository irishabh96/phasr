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
      } catch {
        /* layout still settling */
      }
    };
    requestAnimationFrame(fitNow);
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
      className="h-full min-h-0 w-full overflow-hidden bg-(--color-bg-input)"
      style={{
        paddingTop: 10,
        paddingRight: 8,
        paddingBottom: 16,
        paddingLeft: 16,
      }}
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
