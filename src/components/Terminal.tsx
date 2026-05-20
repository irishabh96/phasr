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

/**
 * Workspace agent terminal. Each instance owns a persistent container
 * DIV that stays in the document forever — when the React component
 * unmounts the container is parked in a hidden host so xterm's canvas
 * never leaves the DOM. WebGL keeps its GPU context, scrollback stays,
 * and the next mount just moves the container back into the visible slot.
 *
 * Only `disposeMainXterm(workspaceId)` destroys the xterm.
 */
interface CachedMain {
  term: XtermTerminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  /** Persistent DOM container — always somewhere in the document. */
  container: HTMLDivElement;
  /** Input/resize handlers — replaced on each remount. */
  inputDisposables: { dispose(): void }[];
  /** True once startWorkspace / loadLog has resolved. */
  started: boolean;
  /** Latest onExit callback (kept fresh across remounts via ref). */
  onExit: ((exitCode: number | null) => void) | undefined;
}

const mainXtermCache = new Map<string, CachedMain>();

let hiddenHost: HTMLDivElement | null = null;
function getHiddenHost(): HTMLDivElement {
  if (!hiddenHost) {
    hiddenHost = document.createElement("div");
    hiddenHost.setAttribute("aria-hidden", "true");
    Object.assign(hiddenHost.style, {
      position: "fixed",
      left: "-9999px",
      top: "0",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      visibility: "hidden",
      pointerEvents: "none",
    });
    document.body.appendChild(hiddenHost);
  }
  return hiddenHost;
}

/** Public teardown. Called by explicit close paths only. */
export function disposeMainXterm(workspaceId: string) {
  const entry = mainXtermCache.get(workspaceId);
  if (!entry) return;
  for (const d of entry.inputDisposables) d.dispose();
  if (entry.webgl) {
    try {
      entry.webgl.dispose();
    } catch {
      /* noop */
    }
  }
  entry.term.dispose();
  if (entry.container.parentNode) {
    entry.container.parentNode.removeChild(entry.container);
  }
  mainXtermCache.delete(workspaceId);
}

export function Terminal({ workspaceId, status, onExit }: TerminalProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const initialStatusRef = useRef(status);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let entry = mainXtermCache.get(workspaceId);

    if (!entry) {
      const initialStatus = initialStatusRef.current;
      const container = document.createElement("div");
      container.className = "h-full w-full";

      const term = createTerminal();
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      let webgl: WebglAddon | null = null;
      try {
        webgl = new WebglAddon();
        term.loadAddon(webgl);
      } catch {
        /* canvas fallback */
      }

      mount.appendChild(container);

      entry = {
        term,
        fit,
        webgl,
        container,
        inputDisposables: [],
        started: false,
        onExit,
      };
      mainXtermCache.set(workspaceId, entry);

      const wireInteractive = () => {
        entry!.inputDisposables = [
          term.onData((data) => {
            void tauri.sendWorkspaceInput(workspaceId, data).catch((err) => {
              term.write(`\r\n\x1b[31m[input error: ${String(err)}]\x1b[0m\r\n`);
            });
          }),
          term.onResize(({ rows, cols }) => {
            void tauri.resizeWorkspace(workspaceId, rows, cols).catch(() => {});
          }),
        ];
        term.focus();
      };

      const startOrAttach = async () => {
        const channel = new Channel<PtyEvent>();
        channel.onmessage = (event) => {
          if (event.type === "output") {
            term.write(event.chunk);
          } else if (event.type === "exit") {
            term.write(
              `\r\n\x1b[2m── process exited${
                event.exitCode == null ? "" : ` (code ${event.exitCode})`
              } ──\x1b[0m\r\n`,
            );
            entry!.onExit?.(event.exitCode);
          }
        };
        try {
          await tauri.startWorkspace(workspaceId, channel, term.rows, term.cols);
          entry!.started = true;
          wireInteractive();
        } catch (err) {
          term.write(`\r\n\x1b[31m✗ Failed to start: ${String(err)}\x1b[0m\r\n`);
        }
      };

      const loadLog = async () => {
        try {
          const log = await tauri.readWorkspaceLog(workspaceId);
          term.write(log.length > 0 ? log : "\x1b[2m(no log output)\x1b[0m\r\n");
          entry!.started = true;
        } catch (err) {
          term.write(`\r\n\x1b[31mFailed to load log: ${String(err)}\x1b[0m\r\n`);
        }
      };

      if (FINISHED_STATUSES.includes(initialStatus)) {
        void loadLog();
      } else {
        void startOrAttach();
      }
    } else {
      // Cache hit — move the persistent container back into this mount.
      mount.appendChild(entry.container);
      entry.onExit = onExit;

      entry.inputDisposables = [
        entry.term.onData((data) => {
          void tauri.sendWorkspaceInput(workspaceId, data).catch((err) => {
            entry!.term.write(`\r\n\x1b[31m[input error: ${String(err)}]\x1b[0m\r\n`);
          });
        }),
        entry.term.onResize(({ rows, cols }) => {
          void tauri.resizeWorkspace(workspaceId, rows, cols).catch(() => {});
        }),
      ];
      entry.term.focus();
    }

    const refit = () => {
      try {
        entry!.fit.fit();
        if (entry!.term.rows > 0) entry!.term.refresh(0, entry!.term.rows - 1);
      } catch {
        /* layout settling */
      }
    };
    const rafId = requestAnimationFrame(refit);

    const resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe(entry.container);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      for (const d of entry!.inputDisposables) d.dispose();
      entry!.inputDisposables = [];
      // Park the persistent container in the hidden host so the canvas
      // stays in the document — preserves the WebGL GPU context.
      getHiddenHost().appendChild(entry!.container);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  return (
    <div
      onClick={() => {
        const buf = mountRef.current?.querySelector("textarea");
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
      <div ref={mountRef} className="h-full w-full" />
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
