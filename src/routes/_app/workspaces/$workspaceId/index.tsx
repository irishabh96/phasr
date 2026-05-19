import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useCreateTask, useTasks } from "@/lib/hooks/useTasks";
import { usePresets } from "@/lib/hooks/usePresets";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import type { Task } from "@/lib/types";

function WorkspaceView() {
  const { workspaceId } = Route.useParams();
  const navigate = useNavigate();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: tasks } = useTasks(workspaceId);
  const { data: presets } = usePresets();
  const createTask = useCreateTask();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);

  const enabledPresets = presets?.filter((p) => p.isEnabled) ?? [];
  const defaultPreset = enabledPresets.find((p) => p.isDefault) ?? enabledPresets[0];
  const activePresetId = presetId ?? defaultPreset?.id ?? null;
  const activePreset = enabledPresets.find((p) => p.id === activePresetId);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !activePreset) return;
    try {
      // The preset launches the agent interactively. The prompt is sent
      // as keystrokes by the PTY runtime after the agent starts up.
      const task = await createTask.mutateAsync({
        workspaceId,
        name: name.trim(),
        command: activePreset.command,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(activePresetId ? { presetId: activePresetId } : {}),
      });
      setName("");
      setPrompt("");
      setShowForm(false);
      navigate({
        to: "/workspaces/$workspaceId/tasks/$taskId",
        params: { workspaceId, taskId: task.id },
      });
    } catch (err) {
      console.error("create task failed", err);
      // The mutation hook surfaces `createTask.error` to the form
      // footer; no extra UI needed here.
    }
  };

  const grouped = groupTasks(tasks ?? []);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/"
            className="text-xs text-(--color-text-muted) hover:text-(--color-text-primary)"
          >
            ← All workspaces
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
            {workspace?.name}
          </h1>
          <p className="truncate text-xs text-(--color-text-muted)">
            {workspace?.localPath ?? "(no local path)"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1 rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-3 py-1.5 text-sm text-white hover:bg-(--color-accent-500)"
        >
          <Plus size={14} />
          New task
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mt-6 space-y-3 rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-4"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Task name (e.g. fix login redirect bug)"
            className="w-full"
            autoFocus
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs text-(--color-text-secondary)">Agent</label>
            <select
              value={activePresetId ?? ""}
              onChange={(e) => setPresetId(e.target.value)}
              className="w-full"
            >
              {enabledPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {activePreset && (
              <code className="block truncate text-[11px] text-(--color-text-muted)">
                {activePreset.command}
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
            {createTask.error && (
              <span className="mr-auto text-xs text-(--color-danger)">
                {String(createTask.error)}
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
              disabled={createTask.isPending || !name.trim() || !activePreset}
              className="rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-3 py-1.5 text-sm text-white hover:bg-(--color-accent-500) disabled:opacity-50"
            >
              {createTask.isPending ? "Creating…" : "Create & open"}
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
                  {list.map((task) => (
                    <li key={task.id} className="py-2.5">
                      <Link
                        to="/workspaces/$workspaceId/tasks/$taskId"
                        params={{ workspaceId, taskId: task.id }}
                        className="flex items-center justify-between gap-3 hover:text-(--color-accent-400)"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm">{task.name}</div>
                          <code className="block truncate text-xs text-(--color-text-muted)">
                            {task.command}
                          </code>
                        </div>
                        <span className="shrink-0 text-xs text-(--color-text-muted)">
                          {relativeTime(task.createdAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          },
        )}
        {(!tasks || tasks.length === 0) && (
          <p className="text-xs text-(--color-text-muted)">
            No tasks yet. Click "New task" to create one.
          </p>
        )}
      </div>
    </div>
  );
}

function groupTasks(tasks: Task[]) {
  const groups: Record<string, Task[]> = {};
  for (const task of tasks) {
    (groups[task.status] ??= []).push(task);
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

export const Route = createFileRoute("/_app/workspaces/$workspaceId/")({
  component: WorkspaceView,
});
