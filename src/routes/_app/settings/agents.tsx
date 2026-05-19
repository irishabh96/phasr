import { createFileRoute } from "@tanstack/react-router";
import { Check, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  useAgents,
  useCreateCustomAgent,
  useDeleteAgent,
  useSetAgentCommand,
  useSetAgentDefault,
  useSetAgentEnabled,
} from "@/lib/hooks/useAgents";
import type { Agent } from "@/lib/types";

function AgentsPage() {
  const { data: agents } = useAgents();
  const setEnabled = useSetAgentEnabled();
  const setCommand = useSetAgentCommand();
  const setDefault = useSetAgentDefault();
  const deleteAgent = useDeleteAgent();
  const createCustom = useCreateCustomAgent();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedCommand, setEditedCommand] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");

  const seeds = (agents ?? []).filter((a) => a.isSeed);
  const customs = (agents ?? []).filter((a) => !a.isSeed);

  const startEdit = (agent: Agent) => {
    setEditingId(agent.id);
    setEditedCommand(agent.command);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditedCommand("");
  };
  const saveEdit = async (id: string) => {
    if (!editedCommand.trim()) return;
    await setCommand.mutateAsync({ id, command: editedCommand.trim() });
    cancelEdit();
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newCommand.trim()) return;
    await createCustom.mutateAsync({
      name: newName.trim(),
      command: newCommand.trim(),
    });
    setNewName("");
    setNewCommand("");
    setShowAdd(false);
  };

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-base font-semibold tracking-tight">Agents</h2>
        <p className="mt-1 text-xs text-(--color-text-muted)">
          Toggle which AI tools appear in the "New workspace" form. Click
          ✎ to change the launch command, ⭐ to set as default, or add a
          custom agent of your own.
        </p>
      </header>

      <section className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-(--color-text-muted)">
          Built-in
        </div>
        <ul className="divide-y divide-(--color-border-subtle) overflow-hidden rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface)">
          {seeds.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              isEditing={editingId === agent.id}
              editedCommand={editedCommand}
              onEditedCommandChange={setEditedCommand}
              onStartEdit={() => startEdit(agent)}
              onCancelEdit={cancelEdit}
              onSaveEdit={() => saveEdit(agent.id)}
              onToggle={(enabled) =>
                setEnabled.mutate({ id: agent.id, enabled })
              }
              onSetDefault={() => setDefault.mutate(agent.id)}
            />
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wide text-(--color-text-muted)">
            Custom ({customs.length})
          </div>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-1 rounded-md border border-(--color-border-default) px-2 py-1 text-xs hover:border-(--color-border-strong)"
          >
            <Plus size={12} />
            Add custom agent
          </button>
        </div>

        {showAdd && (
          <form
            onSubmit={handleAdd}
            className="space-y-2 rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-3"
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Display name (e.g. My GPT-4)"
              className="w-full"
              autoFocus
            />
            <input
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              placeholder="Command (e.g. chat-cli -m gpt-4)"
              className="w-full font-mono text-xs"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  setNewName("");
                  setNewCommand("");
                }}
                className="rounded-md border border-(--color-border-default) px-2 py-1 text-xs hover:border-(--color-border-strong)"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  createCustom.isPending || !newName.trim() || !newCommand.trim()
                }
                className="rounded-md border border-(--color-accent-600) bg-(--color-accent-600) px-2 py-1 text-xs text-white hover:bg-(--color-accent-500) disabled:opacity-50"
              >
                {createCustom.isPending ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        )}

        {customs.length === 0 && !showAdd ? (
          <p className="text-xs text-(--color-text-muted)">
            No custom agents yet.
          </p>
        ) : customs.length > 0 ? (
          <ul className="divide-y divide-(--color-border-subtle) overflow-hidden rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface)">
            {customs.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                isEditing={editingId === agent.id}
                editedCommand={editedCommand}
                onEditedCommandChange={setEditedCommand}
                onStartEdit={() => startEdit(agent)}
                onCancelEdit={cancelEdit}
                onSaveEdit={() => saveEdit(agent.id)}
                onToggle={(enabled) =>
                  setEnabled.mutate({ id: agent.id, enabled })
                }
                onSetDefault={() => setDefault.mutate(agent.id)}
                onDelete={() => {
                  if (window.confirm(`Delete agent "${agent.name}"?`)) {
                    deleteAgent.mutate(agent.id);
                  }
                }}
              />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

interface AgentRowProps {
  agent: Agent;
  isEditing: boolean;
  editedCommand: string;
  onEditedCommandChange(next: string): void;
  onStartEdit(): void;
  onCancelEdit(): void;
  onSaveEdit(): void;
  onToggle(enabled: boolean): void;
  onSetDefault(): void;
  onDelete?: () => void;
}

function AgentRow({
  agent,
  isEditing,
  editedCommand,
  onEditedCommandChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggle,
  onSetDefault,
  onDelete,
}: AgentRowProps) {
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{agent.name}</span>
            {agent.isDefault && (
              <span className="flex items-center gap-1 rounded bg-(--color-accent-600)/15 px-1.5 text-[10px] uppercase tracking-wide text-(--color-accent-400)">
                <Star size={9} fill="currentColor" />
                default
              </span>
            )}
          </div>
          {isEditing ? (
            <input
              autoFocus
              value={editedCommand}
              onChange={(e) => onEditedCommandChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveEdit();
                if (e.key === "Escape") onCancelEdit();
              }}
              className="mt-1 w-full font-mono text-xs"
            />
          ) : (
            <code className="mt-0.5 block truncate text-xs text-(--color-text-muted)">
              {agent.command}
            </code>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={onSaveEdit}
                title="Save"
                className="rounded-md border border-(--color-accent-600) bg-(--color-accent-600) p-1 text-white hover:bg-(--color-accent-500)"
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                title="Cancel"
                className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-border-strong)"
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <>
              {!agent.isDefault && (
                <button
                  type="button"
                  onClick={onSetDefault}
                  title="Set as default"
                  className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
                >
                  <Star size={12} />
                </button>
              )}
              <button
                type="button"
                onClick={onStartEdit}
                title="Edit command"
                className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
              >
                <Pencil size={12} />
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  title="Delete agent"
                  className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-danger) hover:text-(--color-danger)"
                >
                  <Trash2 size={12} />
                </button>
              )}
              <Toggle checked={agent.isEnabled} onChange={onToggle} />
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative ml-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
      style={{
        background: checked ? "var(--color-accent-600)" : "var(--color-bg-elevated)",
      }}
    >
      <span
        className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
      />
    </button>
  );
}

export const Route = createFileRoute("/_app/settings/agents")({
  component: AgentsPage,
});
