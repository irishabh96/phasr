import { useEffect, useState } from "react";
import { BaseBranchField } from "@/components/ui/BaseBranchField";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SettingsCard, SettingsRow } from "@/components/ui/SettingsRow";
import { Switch } from "@/components/ui/Switch";
import { useRepository } from "@/lib/hooks/useRepositories";
import {
  useRemoveWorktrees,
  useRepositoryConfig,
  useRepositoryWorktrees,
  useUpdateRepositoryConfig,
  useWorktreeSizes,
} from "@/lib/hooks/useRepositoryConfig";
import { useUserSettings } from "@/lib/hooks/useUserSettings";
import { humanizeError } from "@/lib/humanizeError";
import { slugify } from "@/lib/slug";
import { showToast } from "@/lib/toast";
import type { CleanupAfterMerge, PrMode, PushPolicy } from "@/lib/types";
import type { UpdateRepositoryConfigInput } from "@/lib/tauri";

/** Text field that saves on blur / Enter (not per keystroke). */
function CommitField({
  value,
  onCommit,
  placeholder,
  label,
  mono = true,
  width = "w-[260px]",
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  label: string;
  mono?: boolean;
  width?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
      className={`h-7 ${width} px-2 py-0 text-[12px] ${mono ? "font-mono" : ""}`}
    />
  );
}

const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function useSave(repositoryId: string) {
  const update = useUpdateRepositoryConfig(repositoryId);
  return (input: UpdateRepositoryConfigInput) =>
    update.mutate(input, {
      onError: (err) => showToast({ intent: "error", title: "Couldn't save", message: humanizeError(err) }),
    });
}

function NoRepository() {
  return (
    <p className="m-0 text-[12px] text-(--color-text-muted)">
      Add a repository to configure its worktrees and branch rules.
    </p>
  );
}

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** A-SettingsPages "WORKTREES (repo)". */
export function WorktreesSettings({ repositoryId }: { repositoryId: string | null }) {
  if (!repositoryId) return <NoRepository />;
  return <Worktrees repositoryId={repositoryId} />;
}

function Worktrees({ repositoryId }: { repositoryId: string }) {
  const { data: cfg } = useRepositoryConfig(repositoryId);
  const { data: settings } = useUserSettings();
  const { data: worktrees } = useRepositoryWorktrees(repositoryId);
  const { data: sizes } = useWorktreeSizes(repositoryId);
  const remove = useRemoveWorktrees(repositoryId);
  const save = useSave(repositoryId);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  /** Paths whose removal would lose uncommitted or unpushed work. */
  const [lossy, setLossy] = useState<{ paths: string[]; message: string } | null>(null);
  const sizeOf = (p: string) => sizes?.find((s) => s.path === p)?.bytes ?? null;
  const total = (sizes ?? []).reduce((n, s) => n + (s.bytes ?? 0), 0);
  const orphans = (worktrees ?? []).filter((w) => w.orphaned).map((w) => w.path);

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <SettingsRow id="settings-row-location" label="Location" help="Where new worktrees are created">
          <CommitField
            label="Worktree location"
            value={cfg?.worktreeBasePath ?? ""}
            placeholder={settings?.worktreeBasePath || "~/.phasr/worktrees"}
            onCommit={(v) => save({ worktreeBasePath: v.trim() || null })}
          />
        </SettingsRow>
        <SettingsRow id="settings-row-after-create" label="After creating" help="Runs once in each new worktree, before the agent starts">
          <CommitField
            label="After creating"
            value={cfg?.preTaskHook ?? ""}
            placeholder="pnpm install"
            onCommit={(v) => save({ preTaskHook: v.trim() || null })}
          />
        </SettingsRow>
        <SettingsRow id="settings-row-copy-untracked" label="Copy untracked files into new worktrees" help="Comma-separated globs; never overwrites">
          <CommitField
            label="Copy untracked globs"
            value={(cfg?.copyUntrackedGlobs ?? []).join(", ")}
            placeholder=".env, .env.local"
            onCommit={(v) => save({ copyUntrackedGlobs: splitList(v) })}
          />
        </SettingsRow>
        <SettingsRow id="settings-row-cleanup" label="Clean up after merge" help="Remove the worktree and local branch once the task merges">
          <SegmentedControl<CleanupAfterMerge>
            label="Clean up after merge"
            value={cfg?.cleanupAfterMerge ?? "ask"}
            onChange={(v) => save({ cleanupAfterMerge: v })}
            options={[
              { value: "ask", label: "Ask" },
              { value: "always", label: "Always" },
              { value: "never", label: "Never" },
            ]}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title={
          <span className="flex items-center gap-2">
            Worktrees
            <span className="font-mono font-normal normal-case tracking-normal">
              {worktrees?.length ?? 0}
              {sizes ? ` · ${formatBytes(total)}` : ""}
            </span>
            <span className="flex-1" />
            {orphans.length > 0 ? (
              <Button size="sm" variant="danger" className="h-6 normal-case tracking-normal" onClick={() => setConfirm(orphans)}>
                Remove {orphans.length} orphaned
              </Button>
            ) : null}
          </span>
        }
      >
        {(worktrees ?? []).length === 0 ? (
          <div data-settings-row className="px-3.5 py-3 text-[12px] text-(--color-text-muted)">
            No task worktrees yet.
          </div>
        ) : (
          (worktrees ?? []).map((w) => (
            <div key={w.path} data-settings-row className="grid grid-cols-[minmax(0,1fr)_140px_80px_72px] items-center gap-3 px-3.5 py-2">
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12px]" title={w.path}>
                  {w.path.replace(/^\/Users\/[^/]+/, "~")}
                </span>
                {w.branch ? <span className="block truncate font-mono text-[11px] text-(--color-text-muted)">{w.branch}</span> : null}
              </span>
              <span className="truncate text-[12px] text-(--color-text-secondary)">
                {w.orphaned ? <span className="text-(--color-warning)">orphaned</span> : (w.taskName ?? "—")}
                {w.lane && !w.orphaned ? <span className="text-(--color-text-muted)"> · {w.lane.replace("-", " ")}</span> : null}
              </span>
              <span className="text-right font-mono text-[11px] text-(--color-text-muted)">{formatBytes(sizeOf(w.path))}</span>
              <span className="flex justify-end">
                <Button size="sm" className="h-6" onClick={() => setConfirm([w.path])}>
                  Remove
                </Button>
              </span>
            </div>
          ))
        )}
      </SettingsCard>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm && confirm.length > 1 ? `Remove ${confirm.length} worktrees?` : "Remove this worktree?"}
        description="The folders are deleted; their branches are kept, so reopening a task rebuilds its worktree from the branch. Uncommitted changes are NOT on the branch — Phasr checks first and asks again if anything would be lost."
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          confirm &&
          remove.mutate(
            { paths: confirm },
            {
              onSuccess: () => setConfirm(null),
              onError: (err) => {
                const message = String(err);
                setConfirm(null);
                if (message.startsWith("uncommitted changes or unpushed commits would be lost"))
                  setLossy({ paths: confirm, message });
                else showToast({ intent: "error", title: "Couldn't remove", message: humanizeError(err) });
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={lossy !== null}
        onOpenChange={(o) => !o && setLossy(null)}
        title="Work would be lost"
        description={`${lossy?.message ?? ""}\n\nRemove anyway? This deletes those changes for good.`}
        confirmLabel="Remove and lose the work"
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          lossy &&
          remove.mutate(
            { paths: lossy.paths, force: true },
            {
              onSuccess: () => setLossy(null),
              onError: (err) => showToast({ intent: "error", title: "Couldn't remove", message: humanizeError(err) }),
            },
          )
        }
      />
    </div>
  );
}

/** A-SettingsPages "BRANCH RULES (repo)". */
export function BranchRulesSettings({ repositoryId }: { repositoryId: string | null }) {
  if (!repositoryId) return <NoRepository />;
  return <BranchRules repositoryId={repositoryId} />;
}

function BranchRules({ repositoryId }: { repositoryId: string }) {
  const { data: repository } = useRepository(repositoryId);
  const { data: cfg } = useRepositoryConfig(repositoryId);
  const { data: settings } = useUserSettings();
  const save = useSave(repositoryId);
  const template = cfg?.branchPrefixTemplate || settings?.branchPrefixTemplate || "phasr/{{slug}}";
  const preview = template
    .replaceAll("{{slug}}", slugify("Fix login redirect"))
    .replaceAll("{{id}}", "a1b2c3d")
    .replaceAll("{{agent}}", "claude");

  return (
    <SettingsCard>
      <SettingsRow id="settings-row-default-base" label="Default base branch" help="Pre-selected in New task" htmlFor="settings-default-base">
        <BaseBranchField
          id="settings-default-base"
          className="w-[200px]"
          repoPath={repository?.localPath}
          defaultBranch={repository?.defaultBranch}
          value={cfg?.defaultBaseBranch ?? repository?.defaultBranch ?? ""}
          disabled={!cfg}
          onChange={(branch) => branch && save({ defaultBaseBranch: branch === repository?.defaultBranch ? null : branch })}
        />
      </SettingsRow>
      <SettingsRow id="settings-row-branch-pattern" label="Branch name pattern" help={<>Preview: <span className="font-mono">{preview}</span> · {"{{slug}} {{id}} {{agent}}"}</>}>
        <CommitField
          label="Branch name pattern"
          value={cfg?.branchPrefixTemplate ?? ""}
          placeholder={settings?.branchPrefixTemplate || "phasr/{{slug}}"}
          onCommit={(v) => save({ branchPrefixTemplate: v.trim() || null })}
          width="w-[200px]"
        />
      </SettingsRow>
      <SettingsRow id="settings-row-fetch-base" label="Fetch base before every task" help="Start from the remote's latest; a failed fetch doesn't block">
        <Switch
          label="Fetch base before every task"
          checked={!!cfg?.fetchBaseBeforeTask}
          disabled={!cfg}
          onChange={(v) => save({ fetchBaseBeforeTask: v })}
        />
      </SettingsRow>
      <SettingsRow id="settings-row-agents-push" label="Agents may push" help="Only their own branch, never the base. Enforced for Claude.">
        <SegmentedControl<PushPolicy>
          label="Agents may push"
          value={cfg?.agentsMayPush ?? "ask"}
          onChange={(v) => save({ agentsMayPush: v })}
          options={[
            { value: "ask", label: "Ask" },
            { value: "allow", label: "Allow" },
            { value: "deny", label: "Never" },
          ]}
        />
      </SettingsRow>
      <SettingsRow id="settings-row-pr-mode" label="Open PRs as">
        <SegmentedControl<PrMode>
          label="Open PRs as"
          value={cfg?.prMode ?? "draft"}
          onChange={(v) => save({ prMode: v })}
          options={[
            { value: "draft", label: "Draft" },
            { value: "ready", label: "Ready" },
          ]}
        />
      </SettingsRow>
      <SettingsRow id="settings-row-protected-paths" label="Protected paths" help="Agents must ask before editing these (comma-separated globs). Enforced for Claude.">
        <CommitField
          label="Protected paths"
          value={(cfg?.protectedPaths ?? []).join(", ")}
          placeholder="src-tauri/tauri.conf.json, .github/**"
          onCommit={(v) => save({ protectedPaths: splitList(v) })}
        />
      </SettingsRow>
      <p className="m-0 px-3.5 py-2.5 text-[11px] text-(--color-text-muted)" data-settings-row>
        Required checks before Approve come from run commands marked “Before review” in Run commands.
      </p>
    </SettingsCard>
  );
}
