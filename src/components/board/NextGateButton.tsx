import { type CSSProperties, type ReactNode, useId, useState } from "react";
import {
  Check,
  Eye,
  GitMerge,
  Loader2,
  RotateCcw,
  Rocket,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { GateVerb, NextGate } from "@/lib/deriveNextGate";

const VERB_ICON: Record<GateVerb, typeof Check> = {
  start: RotateCcw,
  validate: ShieldCheck,
  "request-review": Eye,
  approve: Check,
  bounce: Undo2,
  integrate: GitMerge,
  ship: Rocket,
};

/** Verb → the toast title fragment on a hard failure ("Couldn't request review"). */
const VERB_FAIL: Record<GateVerb, string> = {
  start: "restart",
  validate: "validate",
  "request-review": "request review",
  approve: "approve",
  bounce: "request changes",
  integrate: "integrate",
  ship: "ship",
};

/** Verb → the in-flight gerund label ("Validating…", "Integrating…"). */
const VERB_ING: Record<GateVerb, string> = {
  start: "Restarting",
  validate: "Validating",
  "request-review": "Requesting review",
  approve: "Approving",
  bounce: "Requesting changes",
  integrate: "Integrating",
  ship: "Shipping",
};

/** Default confirm copy for the outward/irreversible gates (§D2). */
function confirmCopy(verb: GateVerb): {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
} {
  if (verb === "ship") {
    return {
      title: "Ship to your main branch?",
      description:
        "This merges the epic's integration branch into your default branch. Make sure you have reviewed the combined diff first.",
      confirmLabel: "Ship",
      destructive: true,
    };
  }
  return {
    title: "Integrate & review?",
    description:
      "This merges every ready ticket into the epic's integration branch, then opens the combined diff for review before you ship.",
    confirmLabel: "Integrate",
    destructive: false,
  };
}

export interface NextGateButtonProps {
  /** The derived gate (the SINGLE source of truth — the button never re-derives). */
  gate: NextGate;
  /**
   * Fires the gate's underlying mutation for an enabled, confirmed click. The
   * button owns the confirm + error toast; the caller owns react-query + any
   * surface side-effect (e.g. integrate opening the combined diff). A rejected
   * promise is humanized into an error toast here.
   */
  onRun: (verb: GateVerb) => void | Promise<unknown>;
  /**
   * Bounce-back handler (required reason). Rendered as a secondary next to
   * Approve when the gate verb is `approve`; opens a comment-capture dialog.
   */
  onBounce?: (comment: string) => void | Promise<unknown>;
  /** External pending (e.g. an integrate mutation's `isPending`) — belt + braces. */
  pending?: boolean;
  size?: "sm" | "md";
  className?: string;
  /** Optional confirm-copy overrides (else defaults per verb). */
  confirmOverride?: Partial<ReturnType<typeof confirmCopy>>;
}

/**
 * The one primary gate button (Phase 3 G1) — generalizes `BoardParentHeader`'s
 * Integrate primary + `BoardCard`'s Mark-done into a single derived reader of
 * {@link NextGate}. It is NEVER hidden: an unmet gate renders calm/disabled with
 * its `reason` as `title` + `aria-describedby` (parity with the old
 * `board-integrate-pending` span). Coral is reserved for the ONE enabled primary
 * (§D1); disabled + terminal gates are muted/soft, never coral.
 *
 * The button owns its own confirm (`ConfirmDialog` for outward/irreversible
 * gates), the Bounce-back comment dialog, and error handling (`humanizeError` →
 * toast) so no call-site repeats it (§A2).
 */
export function NextGateButton({
  gate,
  onRun,
  onBounce,
  pending,
  size = "sm",
  className,
  confirmOverride,
}: NextGateButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bounceOpen, setBounceOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [running, setRunning] = useState(false);
  const reasonId = useId();

  const busy = running || !!pending;
  const Icon = VERB_ICON[gate.verb];
  const isApproveGate = gate.verb === "approve" && gate.enabled;

  const run = async () => {
    if (busy) return;
    setRunning(true);
    try {
      await onRun(gate.verb);
    } catch (err) {
      showToast({
        title: `Couldn't ${VERB_FAIL[gate.verb]}`,
        intent: "error",
        message: humanizeError(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const handleClick = () => {
    if (!gate.enabled || busy) return;
    if (gate.confirm) {
      setConfirmOpen(true);
      return;
    }
    void run();
  };

  const submitBounce = async () => {
    const body = comment.trim();
    if (!body || !onBounce || busy) return;
    setBounceOpen(false);
    setRunning(true);
    try {
      await onBounce(body);
      setComment("");
    } catch (err) {
      showToast({
        title: "Couldn't request changes",
        intent: "error",
        message: humanizeError(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const copy = { ...confirmCopy(gate.verb), ...confirmOverride };

  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <GateButton
          gate={gate}
          size={size}
          busy={busy}
          reasonId={reasonId}
          onClick={handleClick}
          className={className}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Icon className="size-3.5" aria-hidden="true" />
          )}
          {busy ? `${VERB_ING[gate.verb]}…` : gate.label}
        </GateButton>

        {/* Paired Bounce-back secondary (opens the comment dialog). */}
        {isApproveGate && onBounce ? (
          <GlassButton
            variant="outline"
            size={size}
            data-testid="next-gate-bounce"
            disabled={busy}
            onClick={() => setBounceOpen(true)}
            className="gap-1.5"
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
            Request changes
          </GlassButton>
        ) : null}

        {/* Visually-hidden reason for the disabled gate (aria-describedby). */}
        {!gate.enabled && gate.reason ? (
          <span id={reasonId} className="sr-only">
            {gate.reason}
          </span>
        ) : null}
      </span>

      {gate.confirm ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={copy.title}
          description={copy.description}
          confirmLabel={copy.confirmLabel}
          destructive={copy.destructive}
          onConfirm={() => {
            setConfirmOpen(false);
            void run();
          }}
        />
      ) : null}

      {onBounce ? (
        <Dialog
          open={bounceOpen}
          onOpenChange={(o) => {
            if (!o) setBounceOpen(false);
          }}
          title="Request changes"
          description="Leave a note for the agent. It is added to the ticket's comment thread and re-opens the ticket."
          footer={
            <>
              <GlassButton
                variant="outline"
                size="sm"
                onClick={() => setBounceOpen(false)}
              >
                Cancel
              </GlassButton>
              <GlassButton
                variant="primary"
                size="sm"
                data-testid="bounce-submit"
                disabled={comment.trim().length === 0}
                onClick={submitBounce}
              >
                Request changes
              </GlassButton>
            </>
          }
        >
          <GlassTextarea
            data-testid="bounce-comment"
            rows={4}
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What needs to change before this can be approved?"
            className="min-h-[88px] text-[12.5px]"
          />
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The gate glyph+label surface. Enabled primary → coral GlassButton; a disabled
 * gate → a muted, non-hidden pill carrying its reason; a terminal `success`
 * gate (Approved / Shipped) → a calm soft-success pill. Never coral unless it is
 * the one enabled primary (§D1).
 */
function GateButton({
  gate,
  size,
  busy,
  reasonId,
  onClick,
  className,
  children,
}: {
  gate: NextGate;
  size: "sm" | "md";
  busy: boolean;
  reasonId: string;
  onClick: () => void;
  className: string | undefined;
  children: ReactNode;
}) {
  const common =
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-(--radius-control) font-medium";
  const dims =
    size === "sm" ? "h-8 px-3 text-[12px]" : "h-[38px] px-4 text-[13px]";

  // Terminal success pill (Approved / Shipped) — soft success, never coral.
  if (!gate.enabled && gate.intent === "success") {
    const style: CSSProperties = {
      background:
        "color-mix(in oklab, var(--color-success) 14%, var(--color-bg-surface))",
      borderColor: "color-mix(in oklab, var(--color-success) 34%, transparent)",
    };
    return (
      <span
        data-testid="next-gate"
        data-gate-verb={gate.verb}
        data-gate-enabled="false"
        role="status"
        {...(gate.reason ? { title: gate.reason } : {})}
        className={cn(
          common,
          dims,
          "border text-(--color-text-primary)",
          className,
        )}
        style={style}
      >
        {children}
      </span>
    );
  }

  // Disabled-with-reason — calm/muted, present but not actionable (never a dead
  // end; the reason is legible via title + aria-describedby).
  if (!gate.enabled) {
    return (
      <button
        type="button"
        disabled
        data-testid="next-gate"
        data-gate-verb={gate.verb}
        data-gate-enabled="false"
        {...(gate.reason
          ? { title: gate.reason, "aria-describedby": reasonId }
          : {})}
        className={cn(
          common,
          dims,
          "cursor-not-allowed border border-(--color-border-default) text-(--color-text-muted)",
          className,
        )}
      >
        {children}
      </button>
    );
  }

  // The one enabled primary — coral.
  return (
    <GlassButton
      variant="primary"
      size={size}
      data-testid="next-gate"
      data-gate-verb={gate.verb}
      data-gate-enabled="true"
      disabled={busy}
      onClick={onClick}
      className={cn("gap-1.5", className)}
    >
      {children}
    </GlassButton>
  );
}
