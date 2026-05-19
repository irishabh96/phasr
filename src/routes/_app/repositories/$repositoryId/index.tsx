import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Play, Plus, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import { RunCommandPicker } from "@/components/RunCommandPicker";
import { RunCommandsPane } from "@/components/RunCommandsPane";
import { useCreateWorkspace, useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useAgents } from "@/lib/hooks/useAgents";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";
import type { Workspace } from "@/lib/types";

function RepositoryView() {
  const { repositoryId } = Route.useParams();
  const navigate = useNavigate();
  const { data: repository } = useRepository(repositoryId);
  const { data: workspaces } = useWorkspaces(repositoryId);
  const { data: agents } = useAgents();
  const { data: runCommands } = useRunCommands(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);
  const createWorkspace = useCreateWorkspace();

  const pinnedRunCommands = (runCommands ?? []).filter((rc) => rc.pinned);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);

  const enabledAgents = agents?.filter((a) => a.isEnabled) ?? [];
  const defaultAgent = enabledAgents.find((a) => a.isDefault) ?? enabledAgents[0];
  const activeAgentId = agentId ?? defaultAgent?.id ?? null;
  const activeAgent = enabledAgents.find((a) => a.id === activeAgentId);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !activeAgent) return;
    try {
      const workspace = await createWorkspace.mutateAsync({
        repositoryId,
        name: name.trim(),
        command: activeAgent.command,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(activeAgentId ? { agentId: activeAgentId } : {}),
      });
      setName("");
      setPrompt("");
      setShowForm(false);
      navigate({
        to: "/repositories/$repositoryId/workspaces/$workspaceId",
        params: { repositoryId, workspaceId: workspace.id },
      });
    } catch (err) {
      console.error("create workspace failed", err);
    }
  };

  const grouped = groupWorkspaces(workspaces ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/"
            className="text-xs text-(--color-text-muted) hover:text-(--color-text-primary)"
          >
            ← All repositories
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
            {repository?.name}
          </h1>
          <p className="truncate text-xs text-(--color-text-muted)">
            {repository?.localPath ?? "(no local path)"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pinnedRunCommands.map((rc) => (
            <button
              key={rc.id}
              type="button"
              onClick={() => runPanel.openTab(rc.id)}
              title={rc.command}
              className="flex items-center gap-1 rounded-md border border-(--color-border-default) bg-(--color-bg-input) px-2.5 py-1 text-xs text-(--color-text-primary) hover:border-(--color-border-strong)"
            >
              <Play size={11} fill="currentColor" />
              {rc.name}
            </button>
          ))}
          <RunCommandPicker repositoryId={repositoryId} />
          <Link
            to="/repositories/$repositoryId/settings"
            params={{ repositoryId }}
            title="Repository settings"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-(--color-border-default) bg-(--color-bg-input) text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
          >
            <SettingsIcon size={14} />
          </Link>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1 rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-3 py-1.5 text-sm text-white hover:bg-(--color-accent-500)"
          >
            <Plus size={14} />
            New workspace
          </button>
        </div>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mt-6 space-y-3 rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-4"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name (e.g. fix login redirect bug)"
            className="w-full"
            autoFocus
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs text-(--color-text-secondary)">Agent</label>
            <select
              value={activeAgentId ?? ""}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full"
            >
              {enabledAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {activeAgent && (
              <code className="block truncate text-[11px] text-(--color-text-muted)">
                {activeAgent.command}
              </code>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-(--color-text-secondary)">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do?"
              rows={4}
              className="w-full resize-y"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {createWorkspace.error && (
              <span className="mr-auto text-xs text-(--color-danger)">
                {String(createWorkspace.error)}
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-md border border-(--color-border-default) px-3 py-1.5 text-sm text-(--color-text-secondary) hover:border-(--color-border-strong)"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createWorkspace.isPending || !name.trim() || !activeAgent}
              className="rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-3 py-1.5 text-sm text-white hover:bg-(--color-accent-500) disabled:opacity-50"
            >
              {createWorkspace.isPending ? "Creating…" : "Create & open"}
            </button>
          </div>
        </form>
      )}

      <div className="mt-8 space-y-6">
        {(["running", "pending", "completed", "failed", "stopped", "archived"] as const).map(
          (status) => {
            const list = grouped[status];
            if (!list || list.length === 0) return null;
            return (
              <section key={status}>
                <h2 className="text-[11px] font-medium uppercase tracking-wide text-(--color-text-muted)">
                  {status} ({list.length})
                </h2>
                <ul className="mt-2 divide-y divide-(--color-border-subtle)">
                  {list.map((workspace) => (
                    <li key={workspace.id} className="py-2.5">
                      <Link
                        to="/repositories/$repositoryId/workspaces/$workspaceId"
                        params={{ repositoryId, workspaceId: workspace.id }}
                        className="flex items-center justify-between gap-3 hover:text-(--color-accent-400)"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm">{workspace.name}</div>
                          <code className="block truncate text-xs text-(--color-text-muted)">
                            {workspace.command}
                          </code>
                        </div>
                        <span className="shrink-0 text-xs text-(--color-text-muted)">
                          {relativeTime(workspace.createdAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          },
        )}
        {(!workspaces || workspaces.length === 0) && (
          <p className="text-xs text-(--color-text-muted)">
            No workspaces yet. Click "New workspace" to create one.
          </p>
        )}
      </div>
        </div>
      </div>
      <RunCommandsPane repositoryId={repositoryId} />
    </div>
  );
}

function groupWorkspaces(workspaces: Workspace[]) {
  const groups: Record<string, Workspace[]> = {};
  for (const workspace of workspaces) {
    (groups[workspace.status] ??= []).push(workspace);
  }
  return groups;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/")({
  component: RepositoryView,
});
