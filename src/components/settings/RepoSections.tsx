import { Plus } from "lucide-react";
import { useState } from "react";
import { RunCommandsSection } from "@/components/RunCommandsSection";
import { Button } from "@/components/ui/Button";
import { SettingsCard } from "@/components/ui/SettingsRow";
import { useCreateRunCommand, useRunCommands, useUpdateRunCommand } from "@/lib/hooks/useRunCommands";
import { useConfirmRunCommand, useDetectedScripts } from "@/lib/hooks/useReview";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { RunWhen } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { humanizeError } from "@/lib/humanizeError";

function NoRepository() {
  return (
    <p className="m-0 text-[12px] text-(--color-text-muted)">
      Add a repository to configure its run commands, worktrees and branch rules.
    </p>
  );
}

export function RunCommandsSettings({ repositoryId }: { repositoryId: string | null }) {
  const [showAdd, setShowAdd] = useState(false);
  if (!repositoryId) return <NoRepository />;
  return (
    <div id="settings-row-commands" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="m-0 flex-1 text-[12px] text-(--color-text-muted)">
          Scripts you run often. Pinned commands appear in the task pane bar.
        </p>
        <Button size="sm" icon={<Plus className="size-3" aria-hidden />} onClick={() => setShowAdd((v) => !v)}>
          Add command
        </Button>
      </div>
      <RunCommandsSection repositoryId={repositoryId} showAdd={showAdd} onToggleAdd={() => setShowAdd((v) => !v)} />
      <RunCommandAutomation repositoryId={repositoryId} />
      <DetectedScripts repositoryId={repositoryId} />
    </div>
  );
}

const WHEN_OPTIONS: { value: RunWhen; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "task_start", label: "On task start" },
  { value: "before_review", label: "Before review" },
];

/**
 * A-SettingsPages "WHEN": run a command when a task's agent starts (dev
 * server in the worktree) or as a check before review; checks can gate
 * Approve. Synced commands only auto-run after "Allow on this Mac".
 */
function RunCommandAutomation({ repositoryId }: { repositoryId: string }) {
  const { data: commands } = useRunCommands(repositoryId);
  const update = useUpdateRunCommand(repositoryId);
  const confirm = useConfirmRunCommand();
  if (!commands || commands.length === 0) return null;
  const save = (id: string, input: Parameters<typeof update.mutate>[0]["input"]) =>
    update.mutate(
      { id, input },
      { onError: (err) => showToast({ intent: "error", title: "Couldn't save", message: humanizeError(err) }) },
    );
  return (
    <SettingsCard title="When they run">
      {commands.map((rc) => (
        <div key={rc.id} data-settings-row className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
          <div className="flex min-w-[140px] flex-1 flex-col gap-0.5">
            <span className="text-[12px] font-medium">{rc.name}</span>
            <code className="truncate font-mono text-[11px] text-(--color-text-muted)">{rc.command}</code>
          </div>
          <SegmentedControl<RunWhen>
            label={`When ${rc.name} runs`}
            value={rc.runWhen ?? "manual"}
            onChange={(v) => save(rc.id, { runWhen: v, ...(v !== "before_review" ? { requiredForApprove: false } : {}) })}
            options={WHEN_OPTIONS}
          />
          {rc.runWhen === "before_review" ? (
            <label className="flex items-center gap-1.5 text-[12px] text-(--color-text-secondary)">
              <input
                type="checkbox"
                className="size-3.5 p-0 accent-(--color-accent-500)"
                checked={!!rc.requiredForApprove}
                onChange={(e) => save(rc.id, { requiredForApprove: e.target.checked })}
              />
              Required
            </label>
          ) : null}
          <label className="flex items-center gap-1.5 text-[12px] text-(--color-text-secondary)">
            <input
              type="checkbox"
              className="size-3.5 p-0 accent-(--color-accent-500)"
              checked={!!rc.detectPort}
              onChange={(e) => save(rc.id, { detectPort: e.target.checked })}
            />
            Detect port
          </label>
          {rc.runWhen && rc.runWhen !== "manual" ? (
            <Button
              size="sm"
              title="Commands synced from another device only run automatically once allowed here"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate(rc.id)}
            >
              Allow on this Mac
            </Button>
          ) : null}
        </div>
      ))}
    </SettingsCard>
  );
}

function DetectedScripts({ repositoryId }: { repositoryId: string }) {
  const { data: scripts } = useDetectedScripts(repositoryId);
  const create = useCreateRunCommand(repositoryId);
  const fresh = (scripts ?? []).filter((s) => !s.alreadyAdded);
  if (fresh.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-1.5 text-[12px] text-(--color-text-muted)">
      Detected from package.json but not added:
      {fresh.slice(0, 8).map((s) => (
        <button
          key={s.name}
          type="button"
          title={s.command}
          disabled={create.isPending}
          onClick={() => create.mutate({ name: s.name, command: s.command })}
          className="rounded-(--radius-chip) bg-(--color-bg-elevated) px-1.5 py-0.5 font-mono text-[11px] text-(--color-text-secondary) transition-colors duration-(--dur-1) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          + {s.name}
        </button>
      ))}
    </p>
  );
}
