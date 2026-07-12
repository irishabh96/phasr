import { Pencil, Pin, PinOff, Play, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { PanelState } from "@/components/ui/PanelState";
import { useNavigateToRepoEntry } from "@/lib/hooks/useNavigateToRepoEntry";
import {
  useCreateRunCommand,
  useDeleteRunCommand,
  useRunCommands,
  useUpdateRunCommand,
} from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";
import type { RunCommand } from "@/lib/types";

interface RunCommandsSectionProps {
  repositoryId: string;
  showAdd?: boolean;
  onToggleAdd?: () => void;
}

export function RunCommandsSection({
  repositoryId,
  showAdd: externalShowAdd,
  onToggleAdd,
}: RunCommandsSectionProps) {
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

  const isControlled = onToggleAdd !== undefined;
  const [internalShowAdd, setInternalShowAdd] = useState(false);
  const showAdd = isControlled ? (externalShowAdd ?? false) : internalShowAdd;

  const toggleAdd = () => {
    if (isControlled) {
      onToggleAdd();
    } else {
      setInternalShowAdd((v) => !v);
    }
  };

  const closeAdd = () => {
    if (isControlled) {
      if (externalShowAdd) onToggleAdd();
    } else {
      setInternalShowAdd(false);
    }
  };

  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommand, setEditCommand] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<RunCommand | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    await createRC.mutateAsync({ name: name.trim(), command: command.trim() });
    setName("");
    setCommand("");
    closeAdd();
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

  const sorted = useMemo(
    () => [...(runCommands ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [runCommands],
  );

  return (
    <section className="space-y-3">
      {!isControlled && (
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
            Commands
          </div>
          <GlassButton variant="outline" size="sm" onClick={toggleAdd}>
            <Plus size={12} />
            Add
          </GlassButton>
        </div>
      )}

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
                closeAdd();
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

      {sorted.length > 0 && (
        <ul className="divide-y divide-(--color-border-subtle) overflow-hidden rounded-[14px] border border-(--color-border-subtle) bg-(--color-bg-surface)">
          {sorted.map((rc) => {
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
                        <span className="block truncate text-sm font-medium">
                          {rc.name}
                        </span>
                        <code className="block truncate text-[12px] text-(--color-text-muted)">
                          {rc.command}
                        </code>
                      </>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {isEditing ? (
                      <>
                        <GlassButton
                          variant="primary"
                          size="sm"
                          onClick={() => saveEdit(rc.id)}
                          disabled={
                            updateRC.isPending ||
                            !editName.trim() ||
                            !editCommand.trim()
                          }
                        >
                          {updateRC.isPending ? "Saving…" : "Save"}
                        </GlassButton>
                        <GlassButton
                          variant="ghost"
                          size="sm"
                          onClick={cancelEdit}
                        >
                          Cancel
                        </GlassButton>
                      </>
                    ) : (
                      <>
                        <GlassButton
                          variant="ghost"
                          size="sm"
                          onClick={() => runHere(rc.id)}
                          title="Run"
                        >
                          <Play
                            size={11}
                            fill="currentColor"
                            className="text-(--color-accent-text)"
                          />
                          Run
                        </GlassButton>
                        <GlassButton
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            updateRC.mutate({
                              id: rc.id,
                              input: rc.pinned
                                ? { pinned: false }
                                : { pinned: true, sortOrder: Date.now() },
                            })
                          }
                          title={
                            rc.pinned
                              ? "Unpin from workspace toolbar"
                              : "Pin to workspace toolbar (⌘1–9)"
                          }
                          className={
                            rc.pinned ? "text-(--color-accent-text)" : ""
                          }
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
                          onClick={() => setDeleteTarget(rc)}
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

      {sorted.length === 0 && !showAdd && (
        <PanelState
          kind="empty"
          title="No run commands yet"
          description="Save a command you run often to launch it in one click."
          action={
            <GlassButton variant="primary" size="sm" onClick={toggleAdd}>
              <Plus size={12} />
              Add command
            </GlassButton>
          }
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete run command?"
        description={`"${deleteTarget?.name ?? ""}" will be removed. This can't be undone.`}
        destructive
        confirmLabel="Delete"
        pending={deleteRC.isPending}
        pendingLabel="Deleting…"
        onConfirm={() => {
          const target = deleteTarget;
          if (!target) return;
          deleteRC.mutate(target.id, {
            onSettled: () => setDeleteTarget(null),
          });
        }}
      />
    </section>
  );
}
