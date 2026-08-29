import { Channel } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TerminalStatus } from "@/components/TerminalStatus";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useUiStore } from "@/lib/store";
import {
  desyncNotice,
  detachTerminalStream,
  hintTerminalVisible,
  isPtyOutput,
  ptyChunkBytes,
} from "@/lib/ptyChunk";
import { tauri } from "@/lib/tauri";
import {
  canTakeTerminalFocus,
  isSurfaceVisible,
  parkSurface,
  TerminalSurfaceCache,
} from "@/lib/terminal/cache";
import { createTerminalSurface } from "@/lib/terminal/factory";
import { createTerminalLinkSource } from "@/lib/terminal/links";
import { whenGridSettles } from "@/lib/terminal/settle";
import type {
  SurfaceDisposable,
  TerminalBackendKind,
  TerminalSurface,
} from "@/lib/terminal/surface";
import { readTerminalTheme } from "@/lib/terminal/theme";
import type { PtyStreamMessage, WorkspaceStatus } from "@/lib/types";

export interface TerminalProps {
  workspaceId: string;
  /** Snapshot of status at the moment the user opened the workspace. */
  status: WorkspaceStatus;
  /** Whether this terminal's tab is currently the active inner tab. */
  visible: boolean;
  /** Worktree root — resolves relative file-path links in output. */
  cwd?: string | null;
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
 * Workspace agent terminal. Each instance owns a persistent
 * `TerminalSurface` whose element stays in the document forever — when
 * the React component unmounts the element is parked offscreen so the
 * renderer never leaves the DOM. The GPU context survives, scrollback
 * stays, and the next mount just moves the element back into the visible
 * slot.
 *
 * Only `disposeMainTerminal(workspaceId)` destroys the terminal.
 */
interface CachedMain {
  surface: TerminalSurface;
  /** Input/resize handlers — replaced on each remount. */
  inputDisposables: SurfaceDisposable[];
  /** True once openTaskTerminal / loadLog has resolved. */
  started: boolean;
  /** Latest onExit callback (kept fresh across remounts via ref). */
  onExit: ((exitCode: number | null) => void) | undefined;
  /** Latest mount's status setter — lets the persistent PTY channel push
   *  lifecycle updates to the live component after a remount. */
  setStatus: ((s: TermStatus) => void) | null;
  /** Set when the PTY exits so a later remount can restore the overlay. */
  exitStatus: { exitCode: number | null } | null;
  /** Read at click time by the link layer — kept fresh across remounts
   *  (the surface and its link closures outlive component instances). */
  linkContext: { cwd: string | null; editorId: string | null };
  /** Channel id of the live PTY stream, for the visibility hint and the
   *  detach-on-eviction path. `null` until a channel is opened (a finished
   *  workspace replaying its log never opens one). */
  channelId: number | null;
}

const mainSurfaceCache = new TerminalSurfaceCache<CachedMain>("agent");

/** Public teardown. Called by explicit close paths only. */
export function disposeMainTerminal(workspaceId: string) {
  mainSurfaceCache.dispose(workspaceId);
}

export function Terminal({
  workspaceId,
  status,
  visible,
  cwd,
  onExit,
}: TerminalProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const initialStatusRef = useRef(status);
  const { data: settings } = useUserSettings();
  const theme = useUiStore((s) => s.theme);
  const [termStatus, setTermStatus] = useState<TermStatus>(null);
  // Which surface this slot is showing, mirrored onto the container as
  // data-* so e2e can find a terminal and cross-reference the bridge
  // without knowing anything about the emulator's markup.
  const [surfaceInfo, setSurfaceInfo] = useState<{
    kind: TerminalBackendKind;
    id: string;
  } | null>(null);
  // Set inside the mount effect so the overlay's Retry/Restart can re-run
  // the PTY without recreating the whole terminal.
  const retryStartRef = useRef<(() => void) | null>(null);
  const restartRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let entry = mainSurfaceCache.get(workspaceId);
    const isFresh = !entry;

    if (!entry) {
      // Born at the user's font size (when the query has resolved) so the
      // settings effect below doesn't rewrite fontSize on mount — that
      // write costs a WebGL glyph-atlas rebuild.
      const surface = createTerminalSurface(settings);

      mount.appendChild(surface.element);

      // Fit synchronously before starting the PTY so the agent process
      // (e.g. `claude`) inherits the real terminal width on launch.
      // Without this, the grid defaults to 80×24, the PTY is started at
      // 80×24, and the agent draws its welcome screen narrow even
      // though later refits resize the grid.
      if (
        surface.element.clientWidth >= 1 &&
        surface.element.clientHeight >= 1
      ) {
        surface.fit();
      }

      entry = {
        surface,
        inputDisposables: [],
        started: false,
        onExit,
        setStatus: null,
        exitStatus: null,
        linkContext: { cwd: null, editorId: null },
        channelId: null,
      };
      const created = entry;
      surface.installLinks(
        createTerminalLinkSource({
          getCwd: () => created.linkContext.cwd,
          getEditorId: () => created.linkContext.editorId,
        }),
      );
      mainSurfaceCache.set(workspaceId, entry);
    } else {
      // Cache hit — move the persistent element back into this mount.
      mount.appendChild(entry.surface.element);
      entry.onExit = onExit;
    }
    entry.linkContext = {
      cwd: cwd ?? null,
      editorId: settings?.defaultEditor ?? null,
    };

    const surface = entry.surface;
    setSurfaceInfo({ kind: surface.kind, id: surface.id });
    // Route lifecycle updates from the (persistent) PTY channel to the
    // CURRENT mount's React state, so an exit that lands after a remount
    // still reaches the live component instead of a stale setter.
    entry.setStatus = setTermStatus;

    const wireInteractive = () => {
      for (const d of entry!.inputDisposables) d.dispose();
      entry!.inputDisposables = [
        surface.onData((data) => {
          // Routes user keystrokes through the orchestrator's
          // `send_input_to_task` command so the React side speaks
          // task vocabulary end-to-end.
          void tauri.sendInputToTask(workspaceId, data).catch((err) => {
            entry!.setStatus?.({ state: "failed", error: String(err) });
          });
        }),
        surface.onResize(({ rows, cols }) => {
          void tauri.resizeTask(workspaceId, rows, cols).catch(() => {});
        }),
      ];
      surface.focus();
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
      const channel = new Channel<PtyStreamMessage>();
      entry!.channelId = channel.id;
      channel.onmessage = (message) => {
        if (isPtyOutput(message)) {
          // The surface is gone — LRU eviction disposed it while this
          // workspace was parked — so nothing downstream of here can use
          // these bytes. Tell the backend to stop producing them; the PTY
          // keeps running and the next mount re-attaches with replay. One
          // wasted chunk instead of a pipe that runs forever.
          if (!surface.element.isConnected) {
            detachTerminalStream(channel.id);
            return;
          }
          surface.write(ptyChunkBytes(message));
          return;
        }
        if (message.type === "exit") {
          entry!.exitStatus = { exitCode: message.exitCode };
          entry!.setStatus?.({ state: "exited", exitCode: message.exitCode });
          entry!.onExit?.(message.exitCode);
        } else if (message.type === "desync") {
          surface.write(desyncNotice(message.missedBytes));
        }
      };
      try {
        // Let the chrome around the terminal finish settling before the
        // agent reads its size — see whenGridSettles.
        await whenGridSettles(surface);
        await tauri.openTaskTerminal(
          workspaceId,
          channel,
          surface.rows,
          surface.cols,
        );
        entry!.started = true;
        entry!.setStatus?.(null);
        wireInteractive();
        // Catch any fit() that fired between start request and reply — the
        // onResize handler isn't wired during the await, so a resize there
        // is otherwise lost.
        void tauri
          .resizeTask(workspaceId, surface.rows, surface.cols)
          .catch(() => {});
      } catch (err) {
        entry!.setStatus?.({ state: "failed", error: String(err) });
      }
    };

    const loadLog = async (retry = false) => {
      if (retry) entry!.setStatus?.({ state: "retrying" });
      try {
        const log = await tauri.readTaskLog(workspaceId);
        surface.write(
          log.length > 0 ? log : "\x1b[2m(no log output)\x1b[0m\r\n",
        );
        entry!.started = true;
        entry!.setStatus?.(null);
      } catch (err) {
        entry!.setStatus?.({ state: "failed", error: String(err) });
      }
    };

    if (isFresh) {
      if (FINISHED_STATUSES.includes(initialStatusRef.current)) {
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
      // the persistent surface. Restore the exit overlay if the process
      // ended while this workspace was away; otherwise re-wire input.
      retryStartRef.current = () => void startOrAttach("retry");
      restartRef.current = () => void startOrAttach("restart");
      if (entry.exitStatus) {
        setTermStatus({ state: "exited", exitCode: entry.exitStatus.exitCode });
      } else {
        wireInteractive();
      }
    }

    const refit = () => {
      // Skip when hidden — see isSurfaceVisible.
      if (!isSurfaceVisible(surface.element)) return;
      // Anchored, not `fit()`: a width change here is a panel toggle, a
      // window drag or a font-size step, and reflowing for any of them
      // walks the content down the screen. See lib/terminal/reflow.ts.
      surface.fitAnchored();
    };
    // One-shot full redraw after a re-parent; see TerminalSurface.repaint.
    // NOT inside refit (which fires on every resize tick).
    const forceRepaint = () => {
      if (!isSurfaceVisible(surface.element)) return;
      surface.repaint();
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
    resizeObserver.observe(surface.element);

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
      // Park the persistent element offscreen so the canvas stays in the
      // document — preserves the WebGL GPU context.
      parkSurface(entry!.surface);
      // Parked, so nobody can see it: the PTY may widen its flush window.
      // Same bytes, far fewer trips through the IPC — which is the whole
      // point when eight of these are streaming behind the one on screen.
      hintTerminalVisible(entry!.channelId, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    const entry = mainSurfaceCache.get(workspaceId);
    if (!entry) return;
    entry.linkContext.editorId = settings?.defaultEditor ?? null;
    entry.surface.applySettings(settings);
    // A font-size change changes the column count, so it goes through the
    // same anchored path a panel toggle does.
    entry.surface.fitAnchored();
  }, [settings, workspaceId]);

  // Colours come from CSS custom properties read at call time, so a theme
  // flip has to push them into the terminal — the emulator has already
  // rasterized its own copy. Diffed inside the surface, so the mount-time
  // run is a no-op.
  useEffect(() => {
    const entry = mainSurfaceCache.get(workspaceId);
    if (!entry) return;
    entry.surface.applyTheme(readTerminalTheme());
  }, [theme, workspaceId]);

  // When the tab becomes visible (display: none → block), the browser
  // has just laid out the container — fit + repaint synchronously here
  // so the first frame after the visibility flip uses correct
  // dimensions. Prevents the squeezed-to-strip render after a tab
  // switch in. ResizeObserver alone fires on a later tick; doing this
  // synchronously in useLayoutEffect avoids the flicker frame.
  useLayoutEffect(() => {
    const entry = mainSurfaceCache.get(workspaceId);
    if (!entry) return;
    // Finer-grained than mount: this tab stays mounted when it is not the
    // active one, so a `display: none` terminal must be told it is
    // inactive too — ghostty-web's free-running frame loop would otherwise
    // render every hidden tab, forever.
    entry.surface.setActive(visible);
    // The same fact, pushed one layer further down: an inactive surface does
    // not paint, and its PTY does not need to flush on the 8 ms window.
    hintTerminalVisible(entry.channelId, visible);
    if (!visible) return;
    if (!isSurfaceVisible(entry.surface.element)) return;
    // Revealing a tab into a same-width slot is a rows-only change at
    // most, which `fitAnchored` applies synchronously — so this is still
    // the flicker-free path it was.
    entry.surface.fitAnchored();
    // Reset the re-parented canvas so an inner-tab visibility flip
    // repaints without needing a resize.
    entry.surface.repaint();
    // Revealing a terminal hands it the keyboard — otherwise focus stays
    // on the tab pill that was just clicked and typing goes nowhere.
    if (canTakeTerminalFocus()) entry.surface.focus();
  }, [visible, workspaceId]);

  return (
    <div
      onClick={() => mainSurfaceCache.get(workspaceId)?.surface.focus()}
      data-testid="terminal-surface"
      data-terminal-kind={surfaceInfo?.kind}
      data-terminal-id={surfaceInfo?.id}
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
