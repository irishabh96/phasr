import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MergeToMainDialog } from "@/components/MergeToMainDialog";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";
import { useEpicGate } from "@/components/board/useEpicGate";
import { useTicketGate } from "@/components/board/useTicketGate";
import { isIntegrationConflict } from "@/lib/hooks/useBoard";
import type { GateVerb, NextGate } from "@/lib/deriveNextGate";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import type { ValidateResult, Workspace } from "@/lib/types";

/**
 * A single gate command — the human mirror of one `phasr <verb> <ticket>` CLI
 * call. `enabled`/`reason` come straight off the derived {@link NextGate} ladder
 * (never re-derived here); `select` fires the SAME `tauri.ts` mutation the
 * `NextGateButton` does (or opens the shared confirm/comment/merge dialog).
 * Disabled commands are NEVER hidden — they render calm with their `reason`.
 */
export interface GateCommand {
  verb: GateVerb;
  scope: "ticket" | "epic";
  label: string;
  description: string;
  /** Extra searchable text for the ⌘K value (CLI synonyms). */
  keywords: string;
  enabled: boolean;
  /** Disabled-with-reason copy (`title` + inline). `null` when enabled. */
  reason: string | null;
  /** Outward/irreversible (Integrate/Ship) — routes through a confirm surface. */
  confirm: boolean;
  select: () => void;
}

export interface GateCommandsResult {
  /** True when there is a contextual ticket or epic (else render nothing). */
  hasContext: boolean;
  commands: GateCommand[];
  /** Confirm / bounce-comment / ship dialogs — render at the host's STABLE mount. */
  dialogs: ReactNode;
}

const VERB_LABEL: Record<GateVerb, string> = {
  start: "Start",
  validate: "Validate",
  "request-review": "Request review",
  approve: "Approve",
  bounce: "Request changes",
  integrate: "Integrate & review",
  ship: "Ship",
};

const VERB_DESC: Record<GateVerb, string> = {
  start: "Start this ticket's agent",
  validate: "Run this ticket's checks on its branch",
  "request-review": "Send this ticket to the review lane",
  approve: "Approve the review — mark it integrate-eligible",
  bounce: "Bounce back with a comment for the agent",
  integrate: "Merge every ready ticket into the workflow's integration branch",
  ship: "Merge the integration branch into your default branch",
};

/** CLI-synonym keywords so the same verb the agents type is findable in ⌘K. */
const VERB_KEYWORDS: Record<GateVerb, string> = {
  start: "start run spawn",
  validate: "validate check lint test typecheck ci",
  "request-review": "request review qas send handoff mark done",
  approve: "approve qas accept sign off",
  bounce: "bounce back request changes reject reopen",
  integrate: "integrate merge combine",
  ship: "ship release deliver merge to main",
};

const VERB_FAIL: Record<GateVerb, string> = {
  start: "restart",
  validate: "validate",
  "request-review": "request review",
  approve: "approve",
  bounce: "request changes",
  integrate: "integrate",
  ship: "ship",
};

/** Honest reason for a verb that is NOT this entity's current gate. */
function otherVerbReason(gate: NextGate): string {
  if (gate.enabled) return `Not the current step — next up is “${gate.label}”.`;
  return gate.reason ?? "Not available yet.";
}

export interface UseGateCommandsInput {
  /** The contextual workspace (a subtask → ticket + its epic; a parent → epic). */
  workspace: Workspace | null | undefined;
  /** The host surface is open (⌘K palette / ⋯ menu). Gates the queries. */
  active: boolean;
  /** Called when a command is picked, so the host can close (palette/menu). */
  onDispatch?: () => void;
}

/**
 * The shared gate-command coordinator (Phase 3 G2/G3). Derives the ladder for
 * the contextual ticket + epic via {@link useTicketGate}/{@link useEpicGate}
 * (the SAME `deriveNextGate` both the board card and header read), and owns the
 * outward-action dialogs so the ⌘K palette AND the ⋯ menu reuse ONE
 * implementation — no surface repeats the confirm/comment/merge flow or the
 * `humanizeError → toast` handling.
 *
 * Controllers stay alive while any dialog is open or a dispatch is in flight
 * (`gateActive`), so a mutation fired as the host closes still resolves against
 * the correct board.
 */
export function useGateCommands({
  workspace,
  active,
  onDispatch,
}: UseGateCommandsInput): GateCommandsResult {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bounceOpen, setBounceOpen] = useState(false);
  const [shipOpen, setShipOpen] = useState(false);
  const [running, setRunning] = useState(false);

  // Keep the derivation alive through an open dialog / an in-flight dispatch,
  // so a mutation fired as the palette/menu closes still targets the right epic.
  const gateActive = active || confirmOpen || bounceOpen || shipOpen || running;
  const ctx = gateActive ? workspace : null;

  const ticket = useTicketGate(ctx ?? null);
  const epicParentId =
    ctx?.workspaceKind === "subtask"
      ? ctx.parentId
      : ctx?.workspaceKind === "parent"
        ? ctx.id
        : null;
  const epic = useEpicGate(epicParentId);

  const dispatchTicket = async (verb: GateVerb) => {
    if (!ticket) return;
    setRunning(true);
    try {
      const result = await ticket.run(verb);
      if (verb === "validate") {
        const r = result as ValidateResult | undefined;
        const failed = r ? r.checks.filter((c) => !c.passed).length : 0;
        showToast(
          failed > 0
            ? {
                title: `${failed} failing check${failed === 1 ? "" : "s"}`,
                intent: "warning",
                message: "Fix them, then request review.",
              }
            : {
                title: "Checks passed",
                intent: "success",
                message: "This ticket is ready to request review.",
              },
        );
      } else if (verb === "request-review") {
        showToast({ title: "Review requested", intent: "success" });
      } else if (verb === "approve") {
        showToast({
          title: "Approved",
          intent: "success",
          message: "Integrate-eligible from the workflow.",
        });
      }
    } catch (err) {
      showToast({
        title: `Couldn't ${VERB_FAIL[verb]}`,
        intent: "error",
        message: humanizeError(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const submitBounce = async (comment: string) => {
    if (!ticket) return;
    setRunning(true);
    try {
      await ticket.bounce(comment);
      setBounceOpen(false);
      showToast({ title: "Changes requested", intent: "success" });
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

  const runIntegrate = async () => {
    if (!epic) return;
    setConfirmOpen(false);
    setRunning(true);
    const { repositoryId } = epic.parentWorkspace;
    const parentId = epic.parentId;
    try {
      await epic.integrate();
      showToast({
        title: "Integrated",
        intent: "success",
        message: "Review the combined diff on the board.",
      });
      void navigate({
        to: "/repositories/$repositoryId/board/$parentId",
        params: { repositoryId, parentId },
      });
    } catch (err) {
      if (isIntegrationConflict(err)) {
        showToast({
          title: "Integration paused on conflicts",
          intent: "warning",
          message: "Resolve the conflicts from the board.",
        });
        void navigate({
          to: "/repositories/$repositoryId/board/$parentId",
          params: { repositoryId, parentId },
        });
      } else {
        showToast({
          title: "Couldn't integrate",
          intent: "error",
          message: humanizeError(err),
        });
      }
    } finally {
      setRunning(false);
    }
  };

  const commands: GateCommand[] = [];

  if (ticket) {
    const g = ticket.gate;
    const active = (verb: GateVerb) =>
      g.verb === verb
        ? { enabled: g.enabled, reason: g.reason }
        : { enabled: false, reason: otherVerbReason(g) };

    commands.push({
      verb: "validate",
      scope: "ticket",
      label: VERB_LABEL.validate,
      description: VERB_DESC.validate,
      keywords: VERB_KEYWORDS.validate,
      enabled: ticket.canValidate,
      reason: ticket.canValidate ? null : ticket.validateReason,
      confirm: false,
      select: () => {
        onDispatch?.();
        void dispatchTicket("validate");
      },
    });

    const rr = active("request-review");
    commands.push({
      verb: "request-review",
      scope: "ticket",
      label: VERB_LABEL["request-review"],
      description: VERB_DESC["request-review"],
      keywords: VERB_KEYWORDS["request-review"],
      enabled: rr.enabled,
      reason: rr.reason,
      confirm: false,
      select: () => {
        onDispatch?.();
        void dispatchTicket("request-review");
      },
    });

    const ap = active("approve");
    commands.push({
      verb: "approve",
      scope: "ticket",
      label: VERB_LABEL.approve,
      description: VERB_DESC.approve,
      keywords: VERB_KEYWORDS.approve,
      enabled: ap.enabled,
      reason: ap.reason,
      confirm: false,
      select: () => {
        onDispatch?.();
        void dispatchTicket("approve");
      },
    });

    // Bounce-back is the Approve gate's paired secondary — enabled exactly when
    // a review is awaiting the reviewer's decision.
    const canBounce = g.verb === "approve" && g.enabled;
    commands.push({
      verb: "bounce",
      scope: "ticket",
      label: VERB_LABEL.bounce,
      description: VERB_DESC.bounce,
      keywords: VERB_KEYWORDS.bounce,
      enabled: canBounce,
      reason: canBounce ? null : "Only while a review is awaiting your decision",
      confirm: false,
      select: () => {
        setBounceOpen(true);
        onDispatch?.();
      },
    });
  }

  if (epic) {
    const g = epic.gate;
    const isIntegrate = g.verb === "integrate";
    commands.push({
      verb: "integrate",
      scope: "epic",
      label: VERB_LABEL.integrate,
      description: VERB_DESC.integrate,
      keywords: VERB_KEYWORDS.integrate,
      enabled: isIntegrate && g.enabled,
      reason: isIntegrate ? g.reason : otherVerbReason(g),
      confirm: true,
      select: () => {
        setConfirmOpen(true);
        onDispatch?.();
      },
    });

    const isShip = g.verb === "ship";
    commands.push({
      verb: "ship",
      scope: "epic",
      label: epic.baseBranch ? `Ship to ${epic.baseBranch}` : VERB_LABEL.ship,
      description: VERB_DESC.ship,
      keywords: VERB_KEYWORDS.ship,
      enabled: isShip && g.enabled,
      reason: isShip ? g.reason : otherVerbReason(g),
      confirm: true,
      select: () => {
        setShipOpen(true);
        onDispatch?.();
      },
    });
  }

  const dialogs = (
    <>
      {epic ? (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Integrate & review?"
          description="This merges every ready ticket into the workflow's integration branch, then opens the combined diff for review on the board."
          confirmLabel="Integrate"
          pending={running}
          pendingLabel="Integrating…"
          onConfirm={runIntegrate}
        />
      ) : null}
      {epic ? (
        <MergeToMainDialog
          workspace={epic.parentWorkspace}
          open={shipOpen}
          onClose={() => setShipOpen(false)}
        />
      ) : null}
      {ticket ? (
        <BounceCommandDialog
          open={bounceOpen}
          onOpenChange={setBounceOpen}
          pending={running}
          onSubmit={submitBounce}
        />
      ) : null}
    </>
  );

  return { hasContext: !!ticket || !!epic, commands, dialogs };
}

/** The bounce-back comment capture (mirrors the NextGateButton's own dialog). */
function BounceCommandDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (comment: string) => void | Promise<unknown>;
}) {
  const [comment, setComment] = useState("");
  const body = comment.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onOpenChange(false);
          setComment("");
        }
      }}
      title="Request changes"
      description="Leave a note for the agent. It is added to the ticket's comment thread and re-opens the ticket."
      footer={
        <>
          <GlassButton
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </GlassButton>
          <GlassButton
            variant="primary"
            size="sm"
            data-testid="gate-command-bounce-submit"
            disabled={body.length === 0 || pending}
            onClick={() => {
              void onSubmit(body);
              setComment("");
            }}
          >
            Request changes
          </GlassButton>
        </>
      }
    >
      <GlassTextarea
        data-testid="gate-command-bounce-comment"
        rows={4}
        autoFocus
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="What needs to change before this can be approved?"
        className="min-h-[88px] text-[12.5px]"
      />
    </Dialog>
  );
}
