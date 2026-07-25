import { type CSSProperties, useState } from "react";
import { Loader2, PauseCircle, Play } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { ConfirmDialog } from "@/components/ui/Dialog";
import {
  useAutopilotState,
  useSetAutopilotKillSwitch,
} from "@/lib/hooks/useAutopilot";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const WARNING_SURFACE: CSSProperties = {
  background:
    "color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface))",
  borderColor: "color-mix(in oklab, var(--color-warning) 38%, transparent)",
};

/**
 * The presentational "Autopilot halted" banner (Phase 5a, Stage A, §5). An HONEST
 * persistent banner shown while the global kill switch is set: it tells the
 * founder the driver is stopped and offers the ONE explicit un-halt action
 * ("Resume"). There is NO auto-resume — the founder must choose to resume. Pure,
 * so `/design-test` renders it with no IPC.
 */
export function AutopilotHaltedBannerView({
  onResume,
  resuming = false,
  className,
}: {
  onResume: () => void;
  resuming?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-testid="autopilot-halted-banner"
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-(--radius-panel) border px-4 py-3",
        className,
      )}
      style={WARNING_SURFACE}
    >
      <PauseCircle
        className="size-[18px] shrink-0 text-(--color-warning)"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-(--color-text-primary)">
          Autopilot halted
        </span>
        <span className="text-[11.5px] text-(--color-text-muted)">
          The driver is stopped across every epic and will not advance any gate.
          Nothing resumes on its own — resume when you are ready.
        </span>
      </div>
      <GlassButton
        variant="outline"
        size="sm"
        data-testid="autopilot-resume"
        disabled={resuming}
        onClick={onResume}
        className="gap-1.5"
      >
        {resuming ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Play className="size-3.5" aria-hidden="true" />
        )}
        {resuming ? "Resuming…" : "Resume"}
      </GlassButton>
    </div>
  );
}

/**
 * Connected halted banner — reads the GLOBAL persisted kill switch and renders
 * the honest banner (with a wired Resume) only while halted. Renders nothing
 * otherwise, so it is safe to drop at the top of the worklist and the board.
 */
export function AutopilotHaltedBanner({ className }: { className?: string }) {
  const { data } = useAutopilotState();
  const killSwitch = useSetAutopilotKillSwitch();

  if (!data?.killSwitchHalted) return null;

  const resume = () => {
    killSwitch.mutate(false, {
      onError: (err) =>
        showToast({
          title: "Couldn't resume autopilot",
          intent: "error",
          message: humanizeError(err),
        }),
    });
  };

  return (
    <AutopilotHaltedBannerView
      onResume={resume}
      resuming={killSwitch.isPending}
      {...(className ? { className } : {})}
    />
  );
}

/**
 * The global "Halt autopilot" panic button (§5) — a neutral affordance (it is a
 * mode switch, not a status) that flips the persisted kill switch ON behind a
 * confirm. Renders nothing while already halted (the banner's Resume owns the
 * un-halt), so the two never contradict. Placed in a global surface (the worklist
 * header) so one press stops every epic.
 */
export function HaltAutopilotButton({ className }: { className?: string }) {
  const { data } = useAutopilotState();
  const killSwitch = useSetAutopilotKillSwitch();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Nothing to halt if already halted (banner handles Resume).
  if (data?.killSwitchHalted) return null;

  const halt = () => {
    killSwitch.mutate(true, {
      onSuccess: () => setConfirmOpen(false),
      onError: (err) =>
        showToast({
          title: "Couldn't halt autopilot",
          intent: "error",
          message: humanizeError(err),
        }),
    });
  };

  return (
    <>
      <GlassButton
        variant="outline"
        size="sm"
        data-testid="autopilot-halt"
        onClick={() => setConfirmOpen(true)}
        className={cn("gap-1.5", className)}
      >
        <PauseCircle className="size-3.5" aria-hidden="true" />
        Halt autopilot
      </GlassButton>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Halt autopilot everywhere?"
        description={
          "This stops the driver across every workflow immediately — no gate advances and any in-flight agent decision is rejected on arrival. It stays halted until you resume (there is no auto-resume)."
        }
        confirmLabel="Halt autopilot"
        pending={killSwitch.isPending}
        pendingLabel="Halting…"
        onConfirm={halt}
      />
    </>
  );
}
