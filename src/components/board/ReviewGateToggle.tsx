import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { cn } from "@/lib/utils";

/**
 * The per-workflow HUMAN review gate (Stage B, spec §0.5). Shown only while
 * autopilot is on — it has no meaning otherwise.
 *
 * ON (the default on every workflow): every Approve is the founder's. OFF:
 * autopilot spawns a QAS reviewer per requested review — the hands-off path.
 * Turning it OFF is a deliberate, confirmed act: the dialog states plainly
 * what changes AND what does not (Ship is still human; the verdict is
 * re-verified server-side and can't approve past a red validate).
 *
 * Neutral like its Autopilot sibling — a MODE, never a status; the "off"
 * (delegated) state reads as a quiet warning tint, not coral.
 */
export function ReviewGateToggle({
  required,
  pending = false,
  onChange,
}: {
  required: boolean;
  pending?: boolean;
  onChange: (next: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const handleClick = () => {
    // Turning the gate back ON is always safe — no confirm. Turning it OFF
    // delegates your judgement to an agent: that earns a confirmation.
    if (required) setConfirming(true);
    else onChange(true);
  };

  return (
    <>
      <GlassTooltip
        content={
          required
            ? "Reviews are yours to approve"
            : "QAS agent reviews this workflow (Ship is still yours)"
        }
        side="bottom"
      >
        <button
          type="button"
          role="switch"
          aria-checked={!required}
          aria-label="QAS auto-review"
          disabled={pending}
          data-testid="review-gate-toggle"
          data-human-approval-required={required}
          onClick={handleClick}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] leading-none",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
            "disabled:opacity-50",
            required
              ? "border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
              : "border-[color-mix(in_oklab,var(--color-warning)_34%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_10%,transparent)] text-(--color-text-primary)",
          )}
        >
          <ShieldCheck size={12} aria-hidden />
          {required ? "You approve" : "QAS approves"}
        </button>
      </GlassTooltip>

      <Dialog
        open={confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
        size="480px"
        title="Let a QAS agent approve this workflow?"
        description="Autopilot will spawn a reviewer agent for each ticket that requests review, and act on its verdict."
        footer={
          <>
            <GlassButton
              variant="outline"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Keep approving myself
            </GlassButton>
            <GlassButton
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirming(false);
                onChange(false);
              }}
            >
              Let QAS approve
            </GlassButton>
          </>
        }
      >
        <div className="space-y-2 text-[12.5px] leading-relaxed text-(--color-text-secondary)">
          <p>
            An LLM reviewer can be argued into approving work that isn&apos;t
            ready. These guardrails hold regardless:
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <strong className="font-medium text-(--color-text-primary)">
                Ship stays yours.
              </strong>{" "}
              Autopilot can never merge to your default branch.
            </li>
            <li>
              A verdict is re-checked here — an approval can&apos;t land while
              validate is failing.
            </li>
            <li>
              If you approve or bounce first, your decision wins; the
              agent&apos;s stale verdict is rejected.
            </li>
            <li>You can switch this back at any time.</li>
          </ul>
        </div>
      </Dialog>
    </>
  );
}
