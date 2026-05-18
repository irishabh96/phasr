import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { tauri } from "@/lib/tauri";
import type { PtyEvent, TaskStatus } from "@/lib/types";

export interface TerminalProps {
  taskId: string;
  /** Snapshot of status at the moment the user opened the task. Status
   *  changes after mount are intentionally ignored — the PTY runtime
   *  drives further behaviour via exit events. */
  status: TaskStatus;
  onExit?: (exitCode: number | null) => void;
}

const FINISHED_STATUSES: TaskStatus[] = ["completed", "failed", "archived"];

export function Terminal({ taskId, status, onExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Snapshot the *initial* status — we don't want the effect re-running
  // every time the polling task hook flips pending → running.
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
    // Defer the first fit to the next frame so we read the container's
    // final post-layout size, not the pre-paint size.
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
          void tauri.sendTaskInput(taskId, data).catch((err) => {
            term.write(`\r\n\x1b[31m[input error: ${String(err)}]\x1b[0m\r\n`);
          });
        }),
      );
      disposables.push(
        term.onResize(({ rows, cols }) => {
          if (cancelled) return;
          void tauri.resizeTask(taskId, rows, cols).catch(() => {});
        }),
      );
      term.focus();
    };

    const startOrAttach = async () => {
      term.write("\x1b[2m── starting task ──\x1b[0m\r\n");
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
        await tauri.startTask(taskId, channel, term.rows, term.cols);
        if (cancelled) return;
        wireInteractive();
      } catch (err) {
        if (cancelled) return;
        term.write(`\r\n\x1b[31m✗ Failed to start: ${String(err)}\x1b[0m\r\n`);
      }
    };

    const loadLog = async () => {
      try {
        const log = await tauri.readTaskLog(taskId);
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
    // taskId is the ONLY dependency. Status changes mid-mount must NOT
    // re-run this effect (that would dispose the live PTY connection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  return (
    <div
      onClick={() => {
        const buf = containerRef.current?.querySelector("textarea");
        (buf as HTMLTextAreaElement | null)?.focus();
      }}
      className="h-full min-h-0 w-full overflow-hidden bg-(--color-bg-input)"
      style={{
        // Outer padding gives the terminal breathing room. The inner
        // div (which xterm renders into) carries no padding so the
        // FitAddon can compute rows/cols without overestimating.
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
