import { createFileRoute } from "@tanstack/react-router";
import { Check, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { GlassPanel } from "@/components/ui/GlassPanel";
import {
  useAgents,
  useCreateCustomAgent,
  useDeleteAgent,
  useSetAgentCommand,
  useSetAgentDefault,
  useSetAgentEnabled,
} from "@/lib/hooks/useAgents";
import { cn } from "@/lib/utils";
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
    <div className="space-y-6">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight leading-none">Agents</h2>
        <p className="mt-1.5 text-[12px] text-(--color-text-muted)">
          Toggle which AI tools appear in the "New workspace" form. Edit the launch command, set
          a default, or add a custom agent.
        </p>
      </header>

      <section className="space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
          Built-in
        </div>
        <GlassPanel className="divide-y divide-(--glass-border-hairline) overflow-hidden">
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
              onToggle={(enabled) => setEnabled.mutate({ id: agent.id, enabled })}
              onSetDefault={() => setDefault.mutate(agent.id)}
            />
          ))}
        </GlassPanel>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
            Custom <span className="text-(--color-text-secondary)">{customs.length}</span>
          </div>
          <GlassButton variant="outline" size="sm" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={11} />
            Add agent
          </GlassButton>
        </div>

        {showAdd && (
          <GlassPanel className="p-4">
            <form onSubmit={handleAdd} className="space-y-2.5">
              <GlassInput
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Display name (e.g. My GPT-4)"
                autoFocus
              />
              <GlassInput
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                placeholder="Command (e.g. chat-cli -m gpt-4)"
                className="font-mono"
              />
              <div className="flex justify-end gap-2">
                <GlassButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setShowAdd(false);
                    setNewName("");
                    setNewCommand("");
                  }}
                >
                  Cancel
                </GlassButton>
                <GlassButton
                  variant="primary"
                  size="sm"
                  type="submit"
                  disabled={createCustom.isPending || !newName.trim() || !newCommand.trim()}
                >
                  {createCustom.isPending ? "Adding…" : "Add"}
                </GlassButton>
              </div>
            </form>
          </GlassPanel>
        )}

        {customs.length === 0 && !showAdd ? (
          <p className="text-[12px] text-(--color-text-muted)">No custom agents yet.</p>
        ) : customs.length > 0 ? (
          <GlassPanel className="divide-y divide-(--glass-border-hairline) overflow-hidden">
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
                onToggle={(enabled) => setEnabled.mutate({ id: agent.id, enabled })}
                onSetDefault={() => setDefault.mutate(agent.id)}
                onDelete={() => {
                  if (window.confirm(`Delete agent "${agent.name}"?`)) {
                    deleteAgent.mutate(agent.id);
                  }
                }}
              />
            ))}
          </GlassPanel>
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
    <div className="group/agent flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-none">{agent.name}</span>
          {agent.isDefault && (
            <span className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-accent-500)_15%,transparent)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-(--color-accent-400)">
              <Star size={9} fill="currentColor" />
              default
            </span>
          )}
        </div>
        {isEditing ? (
          <GlassInput
            autoFocus
            value={editedCommand}
            onChange={(e) => onEditedCommandChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveEdit();
              if (e.key === "Escape") onCancelEdit();
            }}
            className="mt-2 font-mono text-[11.5px]"
          />
        ) : (
          <code className="mt-1.5 block truncate text-[11.5px] text-(--color-text-muted)">
            {agent.command}
          </code>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isEditing ? (
          <>
            <GlassButton variant="primary" size="sm" onClick={onSaveEdit} title="Save">
              <Check size={11} />
            </GlassButton>
            <GlassButton variant="ghost" size="sm" onClick={onCancelEdit} title="Cancel">
              <X size={11} />
            </GlassButton>
          </>
        ) : (
          <>
            {!agent.isDefault && (
              <GlassButton variant="ghost" size="icon" onClick={onSetDefault} title="Set as default">
                <Star size={12} />
              </GlassButton>
            )}
            <GlassButton variant="ghost" size="icon" onClick={onStartEdit} title="Edit command">
              <Pencil size={12} />
            </GlassButton>
            {onDelete && (
              <GlassButton
                variant="ghost"
                size="icon"
                onClick={onDelete}
                title="Delete agent"
                className="text-(--color-text-muted) hover:text-(--color-danger)"
              >
                <Trash2 size={12} />
              </GlassButton>
            )}
            <Toggle checked={agent.isEnabled} onChange={onToggle} />
          </>
        )}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange(next: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative ml-1 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full",
        "transition-colors duration-150",
        "border border-(--glass-border-hairline)",
        checked
          ? "bg-(--color-accent-500) shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_20%,transparent)]"
          : "bg-[color-mix(in_oklab,white_4%,transparent)]",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow-md",
          "transition-transform duration-150",
        )}
        style={{ transform: checked ? "translateX(14px)" : "translateX(2px)" }}
      />
    </button>
  );
}

export const Route = createFileRoute("/_app/settings/agents")({
  component: AgentsPage,
});
