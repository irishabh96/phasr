import { type CSSProperties } from "react";
import {
  Check,
  CircleAlert,
  Eye,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ValidateResult } from "@/lib/types";

/** Soft-tint chip chrome (mirrors AgentStatusBadge's `soft` tier). Never coral. */
function softStyle(colorVar: string): CSSProperties {
  return {
    background: `color-mix(in oklab, ${colorVar} 14%, var(--color-bg-surface))`,
    borderColor: `color-mix(in oklab, ${colorVar} 34%, transparent)`,
  };
}

const CHIP_BASE =
  "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] font-medium leading-none";

/**
 * The Validate chip (Phase 3 V2). Honest pass/fail/not-run from `validate.json`
 * — soft `success` when green, soft `danger` (with the failing-check count) when
 * red, muted when never run. NEVER coral. When no checks are configured it
 * surfaces the legible "Add a check to validate" affordance (never a dead end).
 */
export function ValidateChip({
  validate,
  checksConfigured,
}: {
  validate: ValidateResult | null | undefined;
  checksConfigured: boolean;
}) {
  // No checks configured → a calm invite, not a status.
  if (!validate && !checksConfigured) {
    return (
      <span
        data-testid="validate-chip"
        data-validate="none"
        className={cn(CHIP_BASE, "text-(--color-text-muted)")}
        title="Mark a run command as a check to validate this ticket."
      >
        <ShieldQuestion className="size-[13px] shrink-0" aria-hidden="true" />
        Add a check to validate
      </span>
    );
  }

  // Configured but never run.
  if (!validate || validate.checks.length === 0) {
    return (
      <span
        data-testid="validate-chip"
        data-validate="not-run"
        className={cn(CHIP_BASE, "text-(--color-text-muted)")}
      >
        <ShieldQuestion className="size-[13px] shrink-0" aria-hidden="true" />
        Not validated
      </span>
    );
  }

  if (validate.passed) {
    return (
      <span
        role="status"
        data-testid="validate-chip"
        data-validate="passed"
        className={cn(CHIP_BASE, "border")}
        style={softStyle("var(--color-success)")}
      >
        <ShieldCheck
          className="size-[13px] shrink-0 text-(--chip-success-fg)"
          aria-hidden="true"
        />
        <span className="text-(--color-text-primary)">Checks passed</span>
      </span>
    );
  }

  const failing = validate.checks.filter((c) => !c.passed).length;
  return (
    <span
      role="status"
      data-testid="validate-chip"
      data-validate="failed"
      className={cn(CHIP_BASE, "border")}
      style={softStyle("var(--color-danger)")}
      title={validate.checks
        .filter((c) => !c.passed)
        .map((c) => c.name)
        .join(", ")}
    >
      <CircleAlert
        className="size-[13px] shrink-0 text-(--chip-danger-fg)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">
        {failing} failing check{failing === 1 ? "" : "s"}
      </span>
    </span>
  );
}

/** In the Review lane, awaiting the reviewer's decision. Working-family (info). */
export function InReviewChip() {
  return (
    <span
      role="status"
      data-testid="in-review-chip"
      className={cn(CHIP_BASE, "border")}
      style={softStyle("var(--color-info)")}
    >
      <Eye
        className="size-[13px] shrink-0 text-(--color-info)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">In review</span>
    </span>
  );
}

/** Approved by the reviewer — integrate-eligible. Soft success. */
export function ApprovedChip() {
  return (
    <span
      role="status"
      data-testid="approved-chip"
      className={cn(CHIP_BASE, "border")}
      style={softStyle("var(--color-success)")}
    >
      <Check
        className="size-[13px] shrink-0 text-(--chip-success-fg)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Approved</span>
    </span>
  );
}

/**
 * A bounced ticket, re-opened for re-work. NEUTRAL/MUTED (mirror `BlockedChip`)
 * — a bounce is not the user's fault, never coral. The reviewer's reason rides
 * the chip (title) and is surfaced inline when supplied.
 */
export function ChangesRequestedChip({ comment }: { comment?: string | null }) {
  const reason = comment?.trim();
  return (
    <span
      role="status"
      data-testid="changes-requested-chip"
      className={cn(CHIP_BASE, "max-w-full")}
      {...(reason ? { title: reason } : {})}
    >
      <CircleAlert
        className="size-[13px] shrink-0 text-(--color-text-muted)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Changes requested</span>
      {reason ? (
        <span className="min-w-0 truncate text-(--color-text-muted)">
          · {reason}
        </span>
      ) : null}
    </span>
  );
}
