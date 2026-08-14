import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TerminalStatus } from "@/components/TerminalStatus";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useUiStore } from "@/lib/store";
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

interface SessionTerminalTabProps {
  /**
   * Workspace id — keys the tab back to the workspace's inner tab strip.
   * Mutually exclusive with `repositoryId`.
   */
  workspaceId?: string;
  /**
   * Repository id — keys the tab back to the repo's inner tab strip
   * (used by the empty-repo screen). Mutually exclusive with `workspaceId`.
   */
  repositoryId?: string;
  tabId: string;
  cwd: string;
  initialCommand?: string;
  /** Persisted from the previous mount, if any. */
  ptySessionId: string | undefined;
  visible: boolean;
}

/**
 * In-app shell terminal. Each instance owns a persistent container DIV
 * that stays in the document forever — when the React component
 * unmounts (route swap, tab visibility flip, HMR) the container is
 * parked in a hidden offscreen host so xterm's canvas never leaves the
 * DOM. WebGL keeps its GPU context, scrollback stays, and the next
 * mount just moves the container back into the visible slot.
 *
 * Only the explicit `disposeSessionXterm(tabId)` call (close-tab,
 * close-workspace, ⌘W on a terminal pill) destroys the xterm.
 */
interface CachedSession {
  term: XtermTerminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  /** Persistent DOM container that hosts the xterm canvas. Lives in
   *  either a workspace's mount slot or the hidden host — never
   *  detached from the document. */
  container: HTMLDivElement;
  channel: Channel<PtyEvent>;
  sessionId: string | null;
  /** Input/resize handlers — replaced on each remount. */
  inputDisposables: { dispose(): void }[];
  /** Read at click time by the link layer — kept fresh across remounts. */
  linkContext: { cwd: string | null; editorId: string | null };
  /** Latest mount's status setter — lets the persistent channel reach the
   *  live component after a remount. */
  setStatus: ((s: TermStatus) => void) | null;
  /** Set when the shell exits so a later remount can restore the overlay. */
  exitStatus: { exitCode: number | null } | null;
}

const sessionXtermCache = new Map<string, CachedSession>();

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

/** Public teardown. Called when the user explicitly closes a terminal tab. */
export function disposeSessionXterm(tabId: string) {
  const entry = sessionXtermCache.get(tabId);
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
  sessionXtermCache.delete(tabId);
}

export function SessionTerminalTab({
  workspaceId,
  repositoryId,
  tabId,
  cwd,
  initialCommand,
  ptySessionId,
  visible,
}: SessionTerminalTabProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const { data: settings } = useUserSettings();
  const [status, setStatus] = useState<TermStatus>(null);
  const retryStartRef = useRef<(() => void) | null>(null);
  const restartRef = useRef<(() => void) | null>(null);
  const setInnerTabPtySession = useUiStore((s) => s.setInnerTabPtySession);
  const setRepoInnerTabPtySession = useUiStore(
    (s) => s.setRepoInnerTabPtySession,
  );
  const persistSession = (id: string) => {
    if (workspaceId) setInnerTabPtySession(workspaceId, tabId, id);
    else if (repositoryId) setRepoInnerTabPtySession(repositoryId, tabId, id);
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let entry = sessionXtermCache.get(tabId);
    const isFresh = !entry;

    if (!entry) {
      // Fresh — create the persistent container and open xterm in it.
      const container = document.createElement("div");
      container.className = "h-full w-full";

      // Born at the user's font size — see Terminal.tsx for why.
      const term = createXtermTerminal(settings);
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

      // Fit synchronously now that the container is in the DOM so the
      // PTY is started at the real terminal width — otherwise the
      // shell (and anything it spawns, like `claude`) inherits xterm's
      // 80×24 defaults and draws its welcome screen at the narrow
      // width even after later resizes.
      try {
        if (container.clientWidth >= 1 && container.clientHeight >= 1) {
          fit.fit();
        }
      } catch {
        /* layout settling — trailing refits will catch up */
      }

      const channel = new Channel<PtyEvent>();
      entry = {
        term,
        fit,
        webgl,
        container,
        channel,
        sessionId: ptySessionId ?? null,
        inputDisposables: [],
        setStatus: null,
        exitStatus: null,
        linkContext: { cwd: null, editorId: null },
      };
      const created = entry;
      installTerminalLinks(term, {
        getCwd: () => created.linkContext.cwd,
        getEditorId: () => created.linkContext.editorId,
      });
      sessionXtermCache.set(tabId, entry);

      channel.onmessage = (event) => {
        if (event.type === "output") {
          term.write(event.chunk);
        } else if (event.type === "exit") {
          entry!.exitStatus = { exitCode: event.exitCode };
          entry!.setStatus?.({ state: "exited", exitCode: event.exitCode });
        }
      };
    } else {
      // Cache hit — move the persistent container back into this mount.
      // appendChild moves the node from wherever it currently lives
      // (hidden host, or a previous mount) without disposing anything.
      mount.appendChild(entry.container);
    }

    const term = entry.term;
    const channel = entry.channel;
    entry.setStatus = setStatus;
    entry.linkContext.cwd = cwd ?? null;

    const wireInteractive = (id: string) => {
      for (const d of entry!.inputDisposables) d.dispose();
      entry!.inputDisposables = [
        term.onData((data) => {
          void tauri.sendSessionInput(id, data).catch((err) => {
            entry!.setStatus?.({ state: "failed", error: String(err) });
          });
        }),
        term.onResize(({ rows, cols }) => {
          void tauri.resizeSession(id, rows, cols).catch(() => {});
        }),
      ];
      term.focus();
    };

    const start = async (mode: StartMode = "initial") => {
      entry!.exitStatus = null;
      entry!.setStatus?.(
        mode === "retry"
          ? { state: "retrying" }
          : mode === "restart"
            ? { state: "restarting" }
            : { state: "starting" },
      );
      try {
        const id = await tauri.startSessionTerminal(
          cwd,
          channel,
          term.rows,
          term.cols,
          initialCommand,
        );
        entry!.sessionId = id;
        persistSession(id);
        entry!.setStatus?.(null);
        wireInteractive(id);
        // Catch any fit() that fired between start request and reply — the
        // onResize handler isn't wired during the await, so a resize there
        // is otherwise lost.
        void tauri.resizeSession(id, term.rows, term.cols).catch(() => {});
      } catch (err) {
        entry!.setStatus?.({ state: "failed", error: String(err) });
      }
    };

    const attach = async (id: string) => {
      try {
        await tauri.attachSessionTerminal(id, channel);
        entry!.setStatus?.(null);
        wireInteractive(id);
        void tauri.resizeSession(id, term.rows, term.cols).catch(() => {});
      } catch {
        // Previous shell is gone — spin up a fresh one (start() shows the
        // "Starting…" overlay in place of the old raw-ANSI note).
        entry!.sessionId = null;
        void start();
      }
    };

    retryStartRef.current = () => void start("retry");
    restartRef.current = () => void start("restart");

    if (isFresh) {
      if (entry.sessionId) {
        void attach(entry.sessionId);
      } else {
        void start("initial");
      }
    } else {
      // Cache hit — the shell (and its channel) are still live. Restore the
      // exit overlay if it ended while away, otherwise re-wire input.
      if (entry.exitStatus) {
        setStatus({ state: "exited", exitCode: entry.exitStatus.exitCode });
      } else if (entry.sessionId) {
        wireInteractive(entry.sessionId);
      }
    }

    const refit = () => {
      try {
        const c = entry!.container;
        // Skip when hidden — fit on a 0×0 container collapses xterm to
        // a 1×1 grid and the WebGL canvas gets stuck rendering into a
        // tiny region even after the tab becomes visible again. The
        // offscreen park host is 1px, so guard on < 2 (not < 1) so a
        // parked container isn't treated as visible.
        if (!c.isConnected || c.clientWidth < 2 || c.clientHeight < 2) return;
        entry!.fit.fit();
        if (entry!.term.rows > 0) entry!.term.refresh(0, entry!.term.rows - 1);
      } catch {
        /* layout settling */
      }
    };
    // See Terminal.tsx — after the canvas is reparented out of the
    // offscreen park host on a same-size switch, fit() no-ops and a bare
    // refresh() leaves the reparented WebGL canvas blank. clearTextureAtlas()
    // resets the atlas + glyph model and redraws without a resize. One-shot
    // only; NOT inside refit (which fires on every resize tick).
    const forceRepaint = () => {
      try {
        const c = entry!.container;
        if (!c.isConnected || c.clientWidth < 2 || c.clientHeight < 2) return;
        if (entry!.webgl) entry!.webgl.clearTextureAtlas();
        else if (entry!.term.rows > 0)
          entry!.term.refresh(0, entry!.term.rows - 1);
      } catch {
        /* renderer paused / layout settling */
      }
    };
    const rafId = requestAnimationFrame(() => {
      refit();
      forceRepaint();
    });
    // See Terminal.tsx — trailing refits catch a delayed window
    // maximize whose ResizeObserver fire lands on stale layout.
    const settleTimers = [
      window.setTimeout(refit, 60),
      window.setTimeout(() => {
        refit();
        forceRepaint();
      }, 250),
      window.setTimeout(refit, 600),
    ];

    const onWindowResize = () => refit();
    window.addEventListener("resize", onWindowResize);

    const resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe(entry.container);

    return () => {
      cancelAnimationFrame(rafId);
      for (const t of settleTimers) window.clearTimeout(t);
      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      for (const d of entry!.inputDisposables) d.dispose();
      entry!.inputDisposables = [];
      // Stop routing channel updates to this (unmounting) instance — a
      // later mount re-points it and restores state from `exitStatus`.
      if (entry!.setStatus === setStatus) entry!.setStatus = null;
      // Park the persistent container in the hidden host so the canvas
      // stays in the document — preserves the WebGL GPU context.
      getHiddenHost().appendChild(entry!.container);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, repositoryId, tabId, cwd, initialCommand]);

  useEffect(() => {
    const entry = sessionXtermCache.get(tabId);
    if (!entry) return;
    entry.linkContext.editorId = settings?.defaultEditor ?? null;
    applyXtermSettings(entry.term, settings);
    try {
      entry.fit.fit();
      if (entry.term.rows > 0) entry.term.refresh(0, entry.term.rows - 1);
    } catch {
      /* layout settling */
    }
  }, [settings, tabId]);

  // When the tab becomes visible (display: none → block), the browser
  // has just laid out the container — fit + refresh synchronously here
  // so the first frame after the visibility flip uses correct
  // dimensions. Prevents the squeezed-to-strip render after a tab
  // switch in. ResizeObserver alone fires on a later tick; doing this
  // synchronously in useLayoutEffect avoids the flicker frame.
  useLayoutEffect(() => {
    if (!visible) return;
    const entry = sessionXtermCache.get(tabId);
    if (!entry) return;
    try {
      const c = entry.container;
      if (!c.isConnected || c.clientWidth < 2 || c.clientHeight < 2) return;
      entry.fit.fit();
      // Reset the reparented WebGL canvas (see forceRepaint above) so an
      // inner-tab visibility flip repaints without needing a resize.
      if (entry.webgl) entry.webgl.clearTextureAtlas();
      else if (entry.term.rows > 0) entry.term.refresh(0, entry.term.rows - 1);
    } catch {
      /* layout still settling */
    }
  }, [visible, tabId]);

  return (
    <div
      onClick={() => {
        const buf = mountRef.current?.querySelector("textarea");
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
      <div ref={mountRef} className="h-full w-full" />
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
