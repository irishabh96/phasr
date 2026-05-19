import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Pin, PinOff, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useRepository } from "@/lib/hooks/useRepositories";
import {
  useCreateRunCommand,
  useDeleteRunCommand,
  useRunCommands,
  useUpdateRunCommand,
} from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";
import type { RunCommand } from "@/lib/types";

function RepositorySettingsPage() {
  const { repositoryId } = Route.useParams();
  const navigate = useNavigate();
  const { data: repository } = useRepository(repositoryId);
  const { data: runCommands } = useRunCommands(repositoryId);
  const createRC = useCreateRunCommand(repositoryId);
  const updateRC = useUpdateRunCommand(repositoryId);
  const deleteRC = useDeleteRunCommand(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);

  const runHere = (id: string) => {
    runPanel.openTab(id);
    navigate({ to: "/repositories/$repositoryId", params: { repositoryId } });
  };

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommand, setEditCommand] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    await createRC.mutateAsync({ name: name.trim(), command: command.trim() });
    setName("");
    setCommand("");
    setShowAdd(false);
  };

  const startEdit = (rc: RunCommand) => {
    setEditingId(rc.id);
    setEditName(rc.name);
    setEditCommand(rc.command);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditCommand("");
  };
  const saveEdit = async (id: string) => {
    if (!editName.trim() || !editCommand.trim()) return;
    await updateRC.mutateAsync({
      id,
      input: { name: editName.trim(), command: editCommand.trim() },
    });
    cancelEdit();
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        to="/repositories/$repositoryId"
        params={{ repositoryId }}
        className="flex items-center gap-1.5 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary)"
      >
        <ArrowLeft size={12} />
        Back to {repository?.name ?? "repository"}
      </Link>

      <header className="mt-4">
        <h1 className="text-xl font-semibold tracking-tight">Repository settings</h1>
        <p className="mt-1 truncate text-xs text-(--color-text-muted)">
          {repository?.name} · {repository?.localPath ?? "(no local path)"}
        </p>
      </header>

      <section className="mt-8 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wide text-(--color-text-muted)">
            Run commands ({runCommands?.length ?? 0})
          </div>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-1 rounded-md border border-(--color-border-default) px-2 py-1 text-xs hover:border-(--color-border-strong)"
          >
            <Plus size={12} />
            Add
          </button>
        </div>

        <p className="text-xs text-(--color-text-muted)">
          Long-running commands that operate on the repository (not a workspace):
          dev servers, test watchers, build tools. Pinned ones get a button in
          the repository header.
        </p>

        {showAdd && (
          <form
            onSubmit={handleCreate}
            className="space-y-2 rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-3"
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (e.g. Dev)"
              className="w-full"
              autoFocus
            />
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Command (e.g. npm run dev)"
              className="w-full font-mono text-xs"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  setName("");
                  setCommand("");
                }}
                className="rounded-md border border-(--color-border-default) px-2 py-1 text-xs hover:border-(--color-border-strong)"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createRC.isPending || !name.trim() || !command.trim()}
                className="rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-2 py-1 text-xs text-white hover:bg-(--color-accent-500) disabled:opacity-50"
              >
                {createRC.isPending ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        )}

        {runCommands && runCommands.length === 0 && !showAdd && (
          <p className="text-xs text-(--color-text-muted)">
            No run commands yet.
          </p>
        )}

        {runCommands && runCommands.length > 0 && (
          <ul className="divide-y divide-(--color-border-subtle) overflow-hidden rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface)">
            {runCommands.map((rc) => {
              const isEditing = editingId === rc.id;
              return (
                <li key={rc.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full text-sm"
                          />
                          <input
                            value={editCommand}
                            onChange={(e) => setEditCommand(e.target.value)}
                            className="w-full font-mono text-xs"
                          />
                        </div>
                      ) : (
                        <>
                          <div className="text-sm font-medium">{rc.name}</div>
                          <code className="block truncate text-xs text-(--color-text-muted)">
                            {rc.command}
                          </code>
                        </>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => saveEdit(rc.id)}
                            className="rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-2 py-1 text-xs text-white hover:bg-(--color-accent-500)"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="rounded-md border border-(--color-border-default) px-2 py-1 text-xs hover:border-(--color-border-strong)"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => runHere(rc.id)}
                            title="Run"
                            className="flex items-center gap-1 rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-2 py-1 text-xs text-white hover:bg-(--color-accent-500)"
                          >
                            <Play size={11} fill="currentColor" />
                            Run
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateRC.mutate({
                                id: rc.id,
                                input: { pinned: !rc.pinned },
                              })
                            }
                            title={rc.pinned ? "Unpin from toolbar" : "Pin to toolbar"}
                            className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
                          >
                            {rc.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(rc)}
                            title="Edit"
                            className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(`Delete "${rc.name}"?`)) {
                                deleteRC.mutate(rc.id);
                              }
                            }}
                            title="Delete"
                            className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-danger) hover:text-(--color-danger)"
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/settings")({
  component: RepositorySettingsPage,
});
