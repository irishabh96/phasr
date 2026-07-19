import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TerminalStatus } from "@/components/TerminalStatus";
import { GlassButton } from "@/components/ui/GlassButton";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { tauri } from "@/lib/tauri";
import { applyXtermSettings, createXtermTerminal } from "@/lib/terminal/xterm";
import type { PtyEvent, WorkspaceStatus } from "@/lib/types";

export interface TerminalProps {
  workspaceId: string;
  /** Snapshot of status at the moment the user opened the workspace. */
  status: WorkspaceStatus;
  /**
   * True when this workspace was orphaned by an app relaunch and swept to
   * `stopped` by startup recovery (`status === "stopped" && interruptedAt`).
   * Such a workspace opens to its REPLAYED pre-interruption log (like a
   * finished status) with an explicit Resume — it must NEVER auto-restart the
   * agent on open. A plain user-stopped workspace (no `interruptedAt`) leaves
   * this false and keeps the click-to-resume attach behavior.
   */
  interrupted?: boolean;
  /** Whether this terminal's tab is currently the active inner tab. */
  visible: boolean;
  onExit?: (exitCode: number | null) => void;
}

const FINISHED_STATUSES: WorkspaceStatus[] = [
  "completed",
  "failed",
  "archived",
];

type StartMode = "initial" | "retry" | "restart";

/** Overlay state driven onto <TerminalStatus>. `null` = no overlay. */
type TermStatus =
  | { state: "starting" | "retrying" | "restarting" }
  | { state: "failed"; error: string }
  | { state: "exited"; exitCode: number | null }
  | null;

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
  /** True once openTaskTerminal / loadLog has resolved. */
  started: boolean;
  /** Latest onExit callback (kept fresh across remounts via ref). */
  onExit: ((exitCode: number | null) => void) | undefined;
  /** Latest mount's status setter — lets the persistent PTY channel push
   *  lifecycle updates to the live component after a remount. */
  setStatus: ((s: TermStatus) => void) | null;
  /** Set when the PTY exits so a later remount can restore the overlay. */
  exitStatus: { exitCode: number | null } | null;
  /** True while a fresh INTERRUPTED open is showing its replayed
   *  pre-interruption log and awaiting an explicit resume. Persisted on the
   *  cache so an inner-tab switch (remount) restores the Resume banner instead
   *  of wiring keystrokes to a dead PTY; cleared once the user resumes. */
  resumable: boolean;
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

export function Terminal({
  workspaceId,
  status,
  interrupted = false,
  visible,
  onExit,
}: TerminalProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const initialStatusRef = useRef(status);
  const { data: settings } = useUserSettings();
  const [termStatus, setTermStatus] = useState<TermStatus>(null);
  // Non-modal banner shown when a fresh interrupted open replays its log —
  // offers the explicit Resume so nothing re-spawns the agent automatically.
  const [resumable, setResumable] = useState(false);
  // Set inside the mount effect so the overlay's Retry/Restart can re-run
  // the PTY without recreating the whole terminal.
  const retryStartRef = useRef<(() => void) | null>(null);
  const restartRef = useRef<(() => void) | null>(null);
  // The interrupted Resume action (re-spawn + dismiss the banner), wired inside
  // the mount effect so the banner button can reach the current PTY closures.
  const resumeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let entry = mainXtermCache.get(workspaceId);
    const isFresh = !entry;

    if (!entry) {
      const container = document.createElement("div");
      container.className = "h-full w-full";

      const term = createXtermTerminal();
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

      // Fit synchronously before starting the PTY so the agent process
      // (e.g. `claude`) inherits the real terminal width on launch.
      // Without this, term defaults to 80×24, the PTY is started at
      // 80×24, and the agent draws its welcome screen narrow even
      // though later refits resize the grid.
      try {
        if (container.clientWidth >= 1 && container.clientHeight >= 1) {
          fit.fit();
        }
      } catch {
        /* layout settling — trailing refits will catch up */
      }

      entry = {
        term,
        fit,
        webgl,
        container,
        inputDisposables: [],
        started: false,
        onExit,
        setStatus: null,
        exitStatus: null,
        resumable: false,
      };
      mainXtermCache.set(workspaceId, entry);
    } else {
      // Cache hit — move the persistent container back into this mount.
      mount.appendChild(entry.container);
      entry.onExit = onExit;
    }

    const term = entry.term;
    // Route lifecycle updates from the (persistent) PTY channel to the
    // CURRENT mount's React state, so an exit that lands after a remount
    // still reaches the live component instead of a stale setter.
    entry.setStatus = setTermStatus;

    const wireInteractive = () => {
      for (const d of entry!.inputDisposables) d.dispose();
      entry!.inputDisposables = [
        term.onData((data) => {
          // Routes user keystrokes through the orchestrator's
          // `send_input_to_task` command so the React side speaks
          // task vocabulary end-to-end.
          void tauri.sendInputToTask(workspaceId, data).catch((err) => {
            entry!.setStatus?.({ state: "failed", error: String(err) });
          });
        }),
        term.onResize(({ rows, cols }) => {
          void tauri.resizeTask(workspaceId, rows, cols).catch(() => {});
        }),
      ];
      term.focus();
    };

    const startOrAttach = async (mode: StartMode = "initial") => {
      entry!.exitStatus = null;
      entry!.setStatus?.(
        mode === "retry"
          ? { state: "retrying" }
          : mode === "restart"
            ? { state: "restarting" }
            : { state: "starting" },
      );
      const channel = new Channel<PtyEvent>();
      channel.onmessage = (event) => {
        if (event.type === "output") {
          term.write(event.chunk);
        } else if (event.type === "exit") {
          entry!.exitStatus = { exitCode: event.exitCode };
          entry!.setStatus?.({ state: "exited", exitCode: event.exitCode });
          entry!.onExit?.(event.exitCode);
        }
      };
      try {
        await tauri.openTaskTerminal(
          workspaceId,
          channel,
          term.rows,
          term.cols,
        );
        entry!.started = true;
        entry!.setStatus?.(null);
        wireInteractive();
        // Catch any fit() that fired between start request and reply — the
        // onResize handler isn't wired during the await, so a resize there
        // is otherwise lost.
        void tauri
          .resizeTask(workspaceId, term.rows, term.cols)
          .catch(() => {});
      } catch (err) {
        entry!.setStatus?.({ state: "failed", error: String(err) });
      }
    };

    const loadLog = async (retry = false) => {
      if (retry) entry!.setStatus?.({ state: "retrying" });
      try {
        const log = await tauri.readTaskLog(workspaceId);
        term.write(log.length > 0 ? log : "\x1b[2m(no log output)\x1b[0m\r\n");
        entry!.started = true;
        entry!.setStatus?.(null);
      } catch (err) {
        entry!.setStatus?.({ state: "failed", error: String(err) });
      }
    };

    // Resume an interrupted agent: a REAL re-spawn (`restart`), and drop the
    // banner. Kept out of the branches so both a fresh open and a remount wire
    // the banner button to the same action.
    const resume = () => {
      entry!.resumable = false;
      setResumable(false);
      void startOrAttach("restart");
    };
    resumeRef.current = resume;

    // Whether this mount should surface the interrupted "Resume" banner.
    let showResumeBanner = false;

    if (isFresh) {
      if (interrupted) {
        // Interrupted (relaunch-orphaned) workspace — the HYBRID case. Replay
        // the pre-interruption log on open like a finished status, so the user
        // sees what the agent did before it was killed. But unlike a finished
        // status, wire Retry/Restart to a REAL re-spawn (`restart`) so the
        // explicit Resume actually resumes the agent — never auto-restart.
        entry.resumable = true;
        showResumeBanner = true;
        retryStartRef.current = () => void startOrAttach("restart");
        restartRef.current = () => void startOrAttach("restart");
        void loadLog();
      } else if (FINISHED_STATUSES.includes(initialStatusRef.current)) {
        // Finished workspace — replay its log. Retry re-reads the log.
        retryStartRef.current = () => void loadLog(true);
        restartRef.current = () => void loadLog(true);
        void loadLog();
      } else {
        retryStartRef.current = () => void startOrAttach("retry");
        restartRef.current = () => void startOrAttach("restart");
        void startOrAttach("initial");
      }
    } else {
      // Cache hit — the PTY (and its channel) are still live and writing to
      // the persistent xterm. Restore the exit overlay if the process ended
      // while this workspace was away; restore the Resume banner if this is an
      // interrupted workspace that hasn't been resumed yet (no live PTY to type
      // into); otherwise re-wire input against the live PTY.
      retryStartRef.current = () => void startOrAttach("retry");
      restartRef.current = () => void startOrAttach("restart");
      if (entry.exitStatus) {
        setTermStatus({ state: "exited", exitCode: entry.exitStatus.exitCode });
      } else if (entry.resumable) {
        showResumeBanner = true;
      } else {
        wireInteractive();
      }
    }
    // Single reset point: clears a stale banner when the same Terminal instance
    // is re-pointed at a non-interrupted workspace (params change, no remount).
    setResumable(showResumeBanner);

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
    // After the canvas is reparented out of the offscreen park host on a
    // same-size workspace switch, fit() no-ops (cols/rows unchanged) and
    // a bare refresh() never resets the reparented WebGL canvas → blank
    // until some resize forces it (which is why toggling a sidebar
    // fixes it). clearTextureAtlas() resets the atlas + glyph model and
    // redraws WITHOUT a resize (no spurious PTY reflow) — reproducing
    // the sidebar-toggle cure. One-shot only; NOT inside refit (which
    // fires on every resize tick and would thrash the atlas on drags).
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
    // The OS may finish applying `maximized: true` after the WebView has
    // already painted and after our first rAF refit. ResizeObserver
    // catches container-size changes, but on macOS the post-maximize
    // resize sometimes lands without the inner flex layout updating in
    // the same tick, so the observer's first fire measures the old
    // width. These trailing refits catch that case.
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
      if (entry!.setStatus === setTermStatus) entry!.setStatus = null;
      // Park the persistent container in the hidden host so the canvas
      // stays in the document — preserves the WebGL GPU context.
      getHiddenHost().appendChild(entry!.container);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const entry = mainXtermCache.get(workspaceId);
    if (!entry) return;
    applyXtermSettings(entry.term, settings);
    try {
      entry.fit.fit();
      if (entry.term.rows > 0) entry.term.refresh(0, entry.term.rows - 1);
    } catch {
      /* layout settling */
    }
  }, [settings, workspaceId]);

  // When the tab becomes visible (display: none → block), the browser
  // has just laid out the container — fit + refresh synchronously here
  // so the first frame after the visibility flip uses correct
  // dimensions. Prevents the squeezed-to-strip render after a tab
  // switch in. ResizeObserver alone fires on a later tick; doing this
  // synchronously in useLayoutEffect avoids the flicker frame.
  useLayoutEffect(() => {
    if (!visible) return;
    const entry = mainXtermCache.get(workspaceId);
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
  }, [visible, workspaceId]);

  return (
    <div
      onClick={() => {
        const buf = mountRef.current?.querySelector("textarea");
        (buf as HTMLTextAreaElement | null)?.focus();
      }}
      className="relative h-full min-h-0 w-full overflow-hidden bg-(--color-bg-terminal)"
      style={{
        display: visible ? "block" : "none",
        paddingTop: 8,
        paddingRight: 8,
        paddingBottom: 4,
        paddingLeft: 16,
      }}
    >
      <div ref={mountRef} className="h-full w-full" />
      {/* Interrupted-on-relaunch: a NON-modal banner so the replayed log stays
          visible behind it. Suppressed while a lifecycle overlay (restarting /
          failed) is up so the two never stack. */}
      {resumable && !termStatus && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-3 pt-3"
          data-testid="terminal-resume-banner"
        >
          <div
            role="status"
            className="glass-panel pointer-events-auto flex max-w-md items-center gap-3 px-3 py-2"
          >
            <p className="text-[12px] leading-snug text-(--color-text-secondary)">
              This agent was interrupted on relaunch. The output below is from
              before it was stopped.
            </p>
            <GlassButton
              variant="primary"
              size="sm"
              className="shrink-0"
              onClick={() => resumeRef.current?.()}
              data-testid="terminal-resume"
            >
              Resume
            </GlassButton>
          </div>
        </div>
      )}
      {termStatus && (
        <TerminalStatus
          state={termStatus.state}
          {...(termStatus.state === "failed"
            ? { error: termStatus.error }
            : {})}
          {...(termStatus.state === "exited"
            ? { exitCode: termStatus.exitCode }
            : {})}
          onRetry={() => retryStartRef.current?.()}
          onRestart={() => restartRef.current?.()}
        />
      )}
    </div>
  );
}
