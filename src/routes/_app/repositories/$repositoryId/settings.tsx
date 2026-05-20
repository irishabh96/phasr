import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Pin, PinOff, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
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
  const { data: repository } = useRepository(repositoryId);
  const { data: runCommands } = useRunCommands(repositoryId);
  const createRC = useCreateRunCommand(repositoryId);
  const updateRC = useUpdateRunCommand(repositoryId);
  const deleteRC = useDeleteRunCommand(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);
  const navigateToRepoEntry = useNavigateToRepoEntry();

  const runHere = (id: string) => {
    runPanel.openTab(id);
    void navigateToRepoEntry(repositoryId);
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
      <button
        type="button"
        onClick={() => void navigateToRepoEntry(repositoryId)}
        className="flex items-center gap-1.5 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary)"
      >
        <ArrowLeft size={12} />
        Back to {repository?.name ?? "repository"}
      </button>

      <header className="mt-4">
        <h1 className="text-xl font-semibold tracking-tight">Repository settings</h1>
        <p className="mt-1 truncate text-xs text-(--color-text-muted)">
          {repository?.name} · {repository?.localPath ?? "(no local path)"}
        </p>
      </header>

      <section className="mt-8 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
            Run commands ({runCommands?.length ?? 0})
          </div>
          <GlassButton variant="outline" size="sm" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={12} />
            Add
          </GlassButton>
        </div>

        <p className="text-[12px] text-(--color-text-muted)">
          Long-running commands that operate on the repository (not a workspace): dev servers,
          test watchers, build tools. Pinned ones get a button in the repository header.
        </p>

        {showAdd && (
          <form
            onSubmit={handleCreate}
            className="space-y-2.5 rounded-[14px] border border-(--color-border-subtle) bg-(--color-bg-surface) p-4"
          >
            <GlassInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (e.g. Dev)"
              autoFocus
            />
            <GlassInput
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Command (e.g. npm run dev)"
              className="font-mono"
            />
            <div className="flex justify-end gap-2">
              <GlassButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowAdd(false);
                  setName("");
                  setCommand("");
                }}
              >
                Cancel
              </GlassButton>
              <GlassButton
                variant="primary"
                size="sm"
                type="submit"
                disabled={createRC.isPending || !name.trim() || !command.trim()}
              >
                {createRC.isPending ? "Adding…" : "Add"}
              </GlassButton>
            </div>
          </form>
        )}

        {runCommands && runCommands.length === 0 && !showAdd && (
          <p className="text-[12px] text-(--color-text-muted)">No run commands yet.</p>
        )}

        {runCommands && runCommands.length > 0 && (
          <ul className="divide-y divide-(--color-border-subtle) overflow-hidden rounded-[14px] border border-(--color-border-subtle) bg-(--color-bg-surface)">
            {runCommands.map((rc) => {
              const isEditing = editingId === rc.id;
              return (
                <li key={rc.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <GlassInput
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                          <GlassInput
                            value={editCommand}
                            onChange={(e) => setEditCommand(e.target.value)}
                            className="font-mono"
                          />
                        </div>
                      ) : (
                        <>
                          <div className="text-sm font-medium">{rc.name}</div>
                          <code className="block truncate text-[12px] text-(--color-text-muted)">
                            {rc.command}
                          </code>
                        </>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {isEditing ? (
                        <>
                          <GlassButton variant="primary" size="sm" onClick={() => saveEdit(rc.id)}>
                            Save
                          </GlassButton>
                          <GlassButton variant="ghost" size="sm" onClick={cancelEdit}>
                            Cancel
                          </GlassButton>
                        </>
                      ) : (
                        <>
                          <GlassButton
                            variant="primary"
                            size="sm"
                            onClick={() => runHere(rc.id)}
                            title="Run"
                          >
                            <Play size={11} fill="currentColor" />
                            Run
                          </GlassButton>
                          <GlassButton
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              updateRC.mutate({
                                id: rc.id,
                                input: { pinned: !rc.pinned },
                              })
                            }
                            title={rc.pinned ? "Unpin from toolbar" : "Pin to toolbar"}
                          >
                            {rc.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                          </GlassButton>
                          <GlassButton
                            variant="ghost"
                            size="icon"
                            onClick={() => startEdit(rc)}
                            title="Edit"
                          >
                            <Pencil size={12} />
                          </GlassButton>
                          <GlassButton
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (window.confirm(`Delete "${rc.name}"?`)) {
                                deleteRC.mutate(rc.id);
                              }
                            }}
                            title="Delete"
                            className="hover:text-(--color-danger)"
                          >
                            <Trash2 size={12} />
                          </GlassButton>
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
