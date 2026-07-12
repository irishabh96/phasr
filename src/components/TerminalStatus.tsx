import {
  CircleAlert,
  CircleCheck,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { cn } from "@/lib/utils";

export type TerminalStatusState =
  | "starting"
  | "retrying"
  | "restarting"
  | "failed"
  | "exited";

interface TerminalStatusProps {
  state: TerminalStatusState;
  /** Raw start error, shown behind a disclosure for `failed`. */
  error?: string;
  /** Process exit code for `exited`. `null`/undefined ⇒ signal/unknown. */
  exitCode?: number | null;
  /** Retry a failed start. Also the action label source for `retrying`. */
  onRetry?: () => void;
  /** Restart after an exit. Also the action label source for `restarting`. */
  onRestart?: () => void;
}

const SUPPORT_LAUNCH = "Launching the process — this usually takes a moment.";

type Resolved = {
  Icon: LucideIcon;
  iconColor: string;
  spin: boolean;
  title: string;
  support: string;
  role: "status" | "alert";
  button: { label: string; disabled: boolean; onClick?: () => void } | null;
};

function resolve(
  state: TerminalStatusState,
  exitCode: number | null | undefined,
  onRetry: (() => void) | undefined,
  onRestart: (() => void) | undefined,
): Resolved {
  switch (state) {
    case "starting":
      return {
        Icon: Loader2,
        iconColor: "text-(--color-info)",
        spin: true,
        title: "Starting…",
        support: SUPPORT_LAUNCH,
        role: "status",
        button: null,
      };
    case "retrying":
      return {
        Icon: Loader2,
        iconColor: "text-(--color-info)",
        spin: true,
        title: "Retrying…",
        support: SUPPORT_LAUNCH,
        role: "status",
        button: { label: "Retry", disabled: true },
      };
    case "restarting":
      return {
        Icon: Loader2,
        iconColor: "text-(--color-info)",
        spin: true,
        title: "Restarting…",
        support: SUPPORT_LAUNCH,
        role: "status",
        button: { label: "Restart", disabled: true },
      };
    case "failed":
      return {
        Icon: CircleAlert,
        iconColor: "text-(--color-danger)",
        spin: false,
        title: "Couldn't start",
        support:
          "The process didn't start. This is usually transient — try again.",
        role: "alert",
        button: {
          label: "Retry",
          disabled: false,
          ...(onRetry ? { onClick: onRetry } : {}),
        },
      };
    case "exited": {
      const restart = {
        label: "Restart",
        disabled: false,
        ...(onRestart ? { onClick: onRestart } : {}),
      };
      if (exitCode === 0) {
        return {
          Icon: CircleCheck,
          iconColor: "text-(--color-success)",
          spin: false,
          title: "Process finished",
          support: "The process exited normally.",
          role: "status",
          button: restart,
        };
      }
      if (typeof exitCode === "number") {
        return {
          Icon: CircleAlert,
          iconColor: "text-(--color-danger)",
          spin: false,
          title: "Process exited",
          support: `It stopped with exit code ${exitCode}.`,
          role: "alert",
          button: restart,
        };
      }
      return {
        Icon: CircleAlert,
        iconColor: "text-(--color-danger)",
        spin: false,
        title: "Process stopped",
        support: "The process ended unexpectedly.",
        role: "alert",
        button: restart,
      };
    }
  }
}

/**
 * One glass overlay for every terminal lifecycle state — starting, a pending
 * retry/restart, a failed spawn (raw error behind a disclosure), and process
 * exit. Replaces both the shadow-xl start-error card and the raw-ANSI exit
 * line with a single AA, keyboard-recoverable surface. The primary action is
 * auto-focused on mount so Enter/Space recovers immediately.
 */
export function TerminalStatus({
  state,
  error,
  exitCode,
  onRetry,
  onRestart,
}: TerminalStatusProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const { Icon, iconColor, spin, title, support, role, button } = resolve(
    state,
    exitCode,
    onRetry,
    onRestart,
  );

  useEffect(() => {
    const btn = primaryRef.current;
    if (btn && !btn.disabled) btn.focus();
  }, []);

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[color-mix(in_oklab,var(--color-bg-terminal)_88%,transparent)] p-6 backdrop-blur-sm">
      <div
        className="glass-panel w-full max-w-sm p-4 text-center"
        role={role}
        aria-live={role === "alert" ? "assertive" : "polite"}
      >
        <div className="flex justify-center">
          <Icon
            className={cn("size-5", iconColor, spin && "animate-spin")}
            aria-hidden="true"
          />
        </div>
        <p className="mt-2 text-[13px] font-semibold text-(--color-text-primary)">
          {title}
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-(--color-text-secondary)">
          {support}
        </p>

        {state === "failed" && error ? (
          <details className="mt-2 text-left">
            <summary className="cursor-pointer select-none text-[11px] text-(--color-text-muted)">
              Details
            </summary>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-(--color-bg-input) p-2 font-mono text-[11px] text-(--color-text-secondary)">
              {error}
            </pre>
          </details>
        ) : null}

        {button ? (
          <GlassButton
            ref={primaryRef}
            variant="primary"
            size="sm"
            className="mt-3 w-full"
            disabled={button.disabled}
            {...(button.onClick ? { onClick: button.onClick } : {})}
          >
            {button.label}
          </GlassButton>
        ) : null}
      </div>
    </div>
  );
}
