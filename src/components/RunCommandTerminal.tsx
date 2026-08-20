import { Channel } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TerminalStatus } from "@/components/TerminalStatus";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { useUiStore } from "@/lib/store";
import { decodePtyChunk } from "@/lib/ptyChunk";
import { tauri } from "@/lib/tauri";
import { canTakeTerminalFocus } from "@/lib/terminal/cache";
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

interface RunCommandTerminalProps {
  /** Run command id (NOT a workspace id). */
  runCommandId: string;
  visible: boolean;
  onExit?: (exitCode: number | null) => void;
}

/**
 * Terminal wired to a Phasr run-command PTY. Built on the same pattern as
 * the workspace `<Terminal>` but talks to the run-command tauri commands
 * (which key PTYs under `run:<id>` so they coexist with workspace PTYs).
 *
 * Unlike the other two surfaces this one is NOT cached: it is created and
 * disposed with the component. Renders even when hidden so the PTY
 * connection survives tab switches; a parent simply toggles its
 * container's display.
 */
export function RunCommandTerminal({
  runCommandId,
  visible,
  onExit,
}: RunCommandTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  const surfaceRef = useRef<TerminalSurface | null>(null);
  const [status, setStatus] = useState<TermStatus>(null);
  // See Terminal.tsx — mirrored onto the container for e2e.
  const [surfaceInfo, setSurfaceInfo] = useState<{
    kind: TerminalBackendKind;
    id: string;
  } | null>(null);
  const retryStartRef = useRef<(() => void) | null>(null);
  const restartRef = useRef<(() => void) | null>(null);
  const { data: settings } = useUserSettings();
  const theme = useUiStore((s) => s.theme);
  onExitRef.current = onExit;
  const editorIdRef = useRef<string | null>(null);
  editorIdRef.current = settings?.defaultEditor ?? null;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    // Born at the user's font size — see Terminal.tsx for why.
    const surface = createTerminalSurface(settingsRef.current);
    surfaceRef.current = surface;
    setSurfaceInfo({ kind: surface.kind, id: surface.id });
    container.appendChild(surface.element);
    // No cwd context on this surface — URL + absolute-path links only.
    surface.installLinks(
      createTerminalLinkSource({
        getCwd: () => null,
        getEditorId: () => editorIdRef.current,
      }),
    );

    // Fit synchronously so startRunCommand receives real rows/cols rather
    // than the 80×24 defaults — see Terminal.tsx for context.
    const fitNow = () => surface.fit();
    fitNow();

    const resizeObserver = new ResizeObserver(fitNow);
    resizeObserver.observe(container);

    const disposables: SurfaceDisposable[] = [];

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      if (event.type === "output") {
        surface.write(decodePtyChunk(event.chunk));
      } else if (event.type === "exit") {
        setStatus({ state: "exited", exitCode: event.exitCode });
        onExitRef.current?.(event.exitCode);
      }
    };

    const start = async (mode: StartMode = "initial") => {
      setStatus(
        mode === "retry"
          ? { state: "retrying" }
          : mode === "restart"
            ? { state: "restarting" }
            : { state: "starting" },
      );
      for (const d of disposables.splice(0)) d.dispose();
      try {
        await tauri.startRunCommand(
          runCommandId,
          channel,
          surface.rows,
          surface.cols,
        );
        if (cancelled) return;
        setStatus(null);
        disposables.push(
          surface.onData((data) => {
            if (cancelled) return;
            void tauri.sendRunCommandInput(runCommandId, data).catch((err) => {
              if (cancelled) return;
              setStatus({ state: "failed", error: String(err) });
            });
          }),
          surface.onResize(({ rows, cols }) => {
            if (cancelled) return;
            void tauri
              .resizeRunCommand(runCommandId, rows, cols)
              .catch(() => {});
          }),
        );
        surface.focus();
      } catch (err) {
        if (cancelled) return;
        setStatus({ state: "failed", error: String(err) });
      }
    };
    retryStartRef.current = () => void start("retry");
    restartRef.current = () => void start("restart");

    void start();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      for (const d of disposables) d.dispose();
      // Disposes the renderer too — this surface owns a WebGL context
      // that used to be leaked on every unmount.
      surface.dispose();
      surfaceRef.current = null;
    };
  }, [runCommandId]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.applySettings(settings);
    surface.fit();
  }, [settings]);

  // See Terminal.tsx — a theme flip has to be pushed into the emulator,
  // which holds its own rasterized copy of the palette.
  useEffect(() => {
    surfaceRef.current?.applyTheme(readTerminalTheme());
  }, [theme]);

  // This surface renders even while its tab is hidden so the PTY stays
  // connected — which is exactly why it has to be told when it is offscreen.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.setActive(visible);
    if (!visible) return;
    surface.fit();
    surface.repaint();
    // See Terminal.tsx — reveal hands over the keyboard.
    if (canTakeTerminalFocus()) surface.focus();
  }, [visible]);

  return (
    <div
      onClick={() => surfaceRef.current?.focus()}
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
      <div ref={containerRef} className="h-full w-full" />
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
