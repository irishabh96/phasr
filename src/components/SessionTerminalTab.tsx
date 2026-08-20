import { Channel } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TerminalStatus } from "@/components/TerminalStatus";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useUiStore } from "@/lib/store";
import { decodePtyChunk } from "@/lib/ptyChunk";
import { tauri } from "@/lib/tauri";
import {
  canTakeTerminalFocus,
  isSurfaceVisible,
  parkSurface,
  TerminalSurfaceCache,
} from "@/lib/terminal/cache";
import { createTerminalSurface } from "@/lib/terminal/factory";
import { createTerminalLinkSource } from "@/lib/terminal/links";
import type {
  SurfaceDisposable,
  TerminalBackendKind,
  TerminalSurface,
} from "@/lib/terminal/surface";
import { readTerminalTheme } from "@/lib/terminal/theme";
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
 * In-app shell terminal. Each instance owns a persistent
 * `TerminalSurface` whose element stays in the document forever — when
 * the React component unmounts (route swap, tab visibility flip, HMR) the
 * element is parked in the shared offscreen host so the renderer never
 * leaves the DOM. The GPU context survives, scrollback stays, and the next
 * mount just moves the element back into the visible slot.
 *
 * Only the explicit `disposeSessionTerminal(tabId)` call (close-tab,
 * close-workspace, ⌘W on a terminal pill) destroys the terminal.
 */
interface CachedSession {
  surface: TerminalSurface;
  channel: Channel<PtyEvent>;
  sessionId: string | null;
  /** Input/resize handlers — replaced on each remount. */
  inputDisposables: SurfaceDisposable[];
  /** Read at click time by the link layer — kept fresh across remounts. */
  linkContext: { cwd: string | null; editorId: string | null };
  /** Latest mount's status setter — lets the persistent channel reach the
   *  live component after a remount. */
  setStatus: ((s: TermStatus) => void) | null;
  /** Set when the shell exits so a later remount can restore the overlay. */
  exitStatus: { exitCode: number | null } | null;
}

const sessionSurfaceCache = new TerminalSurfaceCache<CachedSession>("shell");

/** Public teardown. Called when the user explicitly closes a terminal tab. */
export function disposeSessionTerminal(tabId: string) {
  sessionSurfaceCache.dispose(tabId);
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
  const theme = useUiStore((s) => s.theme);
  const [status, setStatus] = useState<TermStatus>(null);
  // See Terminal.tsx — mirrored onto the container for e2e.
  const [surfaceInfo, setSurfaceInfo] = useState<{
    kind: TerminalBackendKind;
    id: string;
  } | null>(null);
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

    let entry = sessionSurfaceCache.get(tabId);
    const isFresh = !entry;

    if (!entry) {
      // Fresh — create the persistent surface and mount its element.
      // Born at the user's font size — see Terminal.tsx for why.
      const surface = createTerminalSurface(settings);

      mount.appendChild(surface.element);

      // Fit synchronously now that the element is in the DOM so the
      // PTY is started at the real terminal width — otherwise the
      // shell (and anything it spawns, like `claude`) inherits the
      // 80×24 defaults and draws its welcome screen at the narrow
      // width even after later resizes.
      if (
        surface.element.clientWidth >= 1 &&
        surface.element.clientHeight >= 1
      ) {
        surface.fit();
      }

      const channel = new Channel<PtyEvent>();
      entry = {
        surface,
        channel,
        sessionId: ptySessionId ?? null,
        inputDisposables: [],
        setStatus: null,
        exitStatus: null,
        linkContext: { cwd: null, editorId: null },
      };
      const created = entry;
      surface.installLinks(
        createTerminalLinkSource({
          getCwd: () => created.linkContext.cwd,
          getEditorId: () => created.linkContext.editorId,
        }),
      );
      sessionSurfaceCache.set(tabId, entry);

      channel.onmessage = (event) => {
        if (event.type === "output") {
          surface.write(decodePtyChunk(event.chunk));
        } else if (event.type === "exit") {
          created.exitStatus = { exitCode: event.exitCode };
          created.setStatus?.({ state: "exited", exitCode: event.exitCode });
        }
      };
    } else {
      // Cache hit — move the persistent element back into this mount.
      // appendChild moves the node from wherever it currently lives
      // (park host, or a previous mount) without disposing anything.
      mount.appendChild(entry.surface.element);
    }

    const surface = entry.surface;
    const channel = entry.channel;
    setSurfaceInfo({ kind: surface.kind, id: surface.id });
    entry.setStatus = setStatus;
    entry.linkContext.cwd = cwd ?? null;

    const wireInteractive = (id: string) => {
      for (const d of entry!.inputDisposables) d.dispose();
      entry!.inputDisposables = [
        surface.onData((data) => {
          void tauri.sendSessionInput(id, data).catch((err) => {
            entry!.setStatus?.({ state: "failed", error: String(err) });
          });
        }),
        surface.onResize(({ rows, cols }) => {
          void tauri.resizeSession(id, rows, cols).catch(() => {});
        }),
      ];
      surface.focus();
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
          surface.rows,
          surface.cols,
          initialCommand,
        );
        entry!.sessionId = id;
        persistSession(id);
        entry!.setStatus?.(null);
        wireInteractive(id);
        // Catch any fit() that fired between start request and reply — the
        // onResize handler isn't wired during the await, so a resize there
        // is otherwise lost.
        void tauri
          .resizeSession(id, surface.rows, surface.cols)
          .catch(() => {});
      } catch (err) {
        entry!.setStatus?.({ state: "failed", error: String(err) });
      }
    };

    const attach = async (id: string) => {
      try {
        await tauri.attachSessionTerminal(id, channel);
        entry!.setStatus?.(null);
        wireInteractive(id);
        void tauri
          .resizeSession(id, surface.rows, surface.cols)
          .catch(() => {});
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
      // Skip when hidden — see isSurfaceVisible.
      if (!isSurfaceVisible(surface.element)) return;
      surface.fit();
    };
    // See Terminal.tsx — one-shot full redraw after a re-parent, never on
    // a resize tick.
    const forceRepaint = () => {
      if (!isSurfaceVisible(surface.element)) return;
      surface.repaint();
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
      if (entry!.setStatus === setStatus) entry!.setStatus = null;
      // Park the persistent element offscreen so the canvas stays in the
      // document — preserves the WebGL GPU context.
      parkSurface(entry!.surface);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, repositoryId, tabId, cwd, initialCommand]);

  useEffect(() => {
    const entry = sessionSurfaceCache.get(tabId);
    if (!entry) return;
    entry.linkContext.editorId = settings?.defaultEditor ?? null;
    entry.surface.applySettings(settings);
    entry.surface.fit();
  }, [settings, tabId]);

  // See Terminal.tsx — a theme flip has to be pushed into the emulator,
  // which holds its own rasterized copy of the palette.
  useEffect(() => {
    const entry = sessionSurfaceCache.get(tabId);
    if (!entry) return;
    entry.surface.applyTheme(readTerminalTheme());
  }, [theme, tabId]);

  // When the tab becomes visible (display: none → block), the browser
  // has just laid out the container — fit + repaint synchronously here
  // so the first frame after the visibility flip uses correct
  // dimensions. Prevents the squeezed-to-strip render after a tab
  // switch in. ResizeObserver alone fires on a later tick; doing this
  // synchronously in useLayoutEffect avoids the flicker frame.
  useLayoutEffect(() => {
    const entry = sessionSurfaceCache.get(tabId);
    if (!entry) return;
    // See Terminal.tsx — a mounted-but-hidden tab must be inactive too.
    entry.surface.setActive(visible);
    if (!visible) return;
    if (!isSurfaceVisible(entry.surface.element)) return;
    entry.surface.fit();
    // Reset the re-parented canvas so an inner-tab visibility flip
    // repaints without needing a resize.
    entry.surface.repaint();
    // See Terminal.tsx — reveal hands over the keyboard.
    if (canTakeTerminalFocus()) entry.surface.focus();
  }, [visible, tabId]);

  return (
    <div
      onClick={() => sessionSurfaceCache.get(tabId)?.surface.focus()}
      data-testid="terminal-surface"
      data-terminal-kind={surfaceInfo?.kind}
      data-terminal-id={surfaceInfo?.id}
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
