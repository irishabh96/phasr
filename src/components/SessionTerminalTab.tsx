import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { PtyEvent } from "@/lib/types";

interface SessionTerminalTabProps {
  /** Repository id — keys the tab back to the right strip. */
  repositoryId: string;
  tabId: string;
  cwd: string;
  /** Persisted from the previous mount, if any. Reattaches when set. */
  ptySessionId: string | undefined;
  visible: boolean;
}

/**
 * In-app shell terminal — the content of a `terminal` tab on the repo
 * detail page. Models RunCommandTerminal closely; the difference is the
 * backend tracks sessions in-memory by uuid (no DB row). We persist the
 * returned sessionId on the tab so re-mounting the tab (e.g. switching
 * between tabs) reuses the same PTY.
 */
export function SessionTerminalTab({
  repositoryId,
  tabId,
  cwd,
  ptySessionId,
  visible,
}: SessionTerminalTabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setTabPtySession = useUiStore((s) => s.setTabPtySession);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let sessionId = ptySessionId ?? null;

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
          `\r\n\x1b[2m── shell exited${
            event.exitCode == null ? "" : ` (code ${event.exitCode})`
          } ──\x1b[0m\r\n`,
        );
      }
    };

    const wireInteractive = (id: string) => {
      disposables.push(
        term.onData((data) => {
          if (cancelled) return;
          void tauri.sendSessionInput(id, data).catch(() => {});
        }),
        term.onResize(({ rows, cols }) => {
          if (cancelled) return;
          void tauri.resizeSession(id, rows, cols).catch(() => {});
        }),
      );
      term.focus();
    };

    const start = async () => {
      term.write("\x1b[2m── starting shell ──\x1b[0m\r\n");
      try {
        const id = await tauri.startSessionTerminal(cwd, channel, term.rows, term.cols);
        if (cancelled) return;
        sessionId = id;
        setTabPtySession(repositoryId, tabId, id);
        wireInteractive(id);
      } catch (err) {
        if (cancelled) return;
        term.write(`\r\n\x1b[31m✗ Failed to start shell: ${String(err)}\x1b[0m\r\n`);
      }
    };

    if (sessionId) {
      // Re-attach: just wire interactive handlers; the PTY is still
      // alive on the Rust side. Output already streamed before this
      // mount is lost (xterm scrollback would have it if the previous
      // mount wasn't disposed) — accepted v1 trade-off.
      wireInteractive(sessionId);
      term.write("\x1b[2m── reattached ──\x1b[0m\r\n");
    } else {
      void start();
    }

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      for (const d of disposables) d.dispose();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId, tabId, cwd]);

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
