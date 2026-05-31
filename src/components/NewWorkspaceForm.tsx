import { useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput, GlassTextarea } from "@/components/ui/GlassInput";
import { useAgents } from "@/lib/hooks/useAgents";
import { useCreateWorkspace } from "@/lib/hooks/useWorkspaces";
import { reportP0Error } from "@/lib/sentry";
import type { Agent, Workspace } from "@/lib/types";

interface NewWorkspaceFormProps {
  repositoryId: string;
  onCreated?: (workspace: Workspace) => void;
  onCancel?: () => void;
  /** Defaults to "Create & open". */
  submitLabel?: string;
  /** When false, the Cancel button is hidden. Useful in single-step contexts. */
  showCancel?: boolean;
  autoFocus?: boolean;
}

/**
 * The "create your first workspace" form. Used both inline on the
 * repository detail page and as the final step of the New Project
 * wizard. Behaves identically in both — the only knobs are the submit
 * label and whether Cancel is rendered.
 */
export function NewWorkspaceForm({
  repositoryId,
  onCreated,
  onCancel,
  submitLabel = "Create & open",
  showCancel = true,
  autoFocus = true,
}: NewWorkspaceFormProps) {
  const { data: agents } = useAgents();
  const createWorkspace = useCreateWorkspace();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState<Agent | null>(null);

  const allAgents = agents ?? [];
  const defaultAgent = allAgents.find((a) => a.isDefault) ?? allAgents[0];
  const activeAgentValue = agent ?? defaultAgent?.agent ?? null;
  const activeAgent = allAgents.find((a) => a.agent === activeAgentValue);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !activeAgent) return;
    try {
      const workspace = await createWorkspace.mutateAsync({
        repositoryId,
        name: name.trim(),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        agent: activeAgent.agent,
      });
      setName("");
      setPrompt("");
      onCreated?.(workspace);
    } catch (err) {
      reportP0Error("Create workspace failed", err, {
        area: "workspace",
        operation: "create_workspace",
        repositoryId,
        agentId: activeAgentValue,
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <GlassInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Workspace name (e.g. fix login redirect bug)"
        autoFocus={autoFocus}
      />
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Agent
        </label>
        <select
          value={activeAgentValue ?? ""}
          onChange={(e) => setAgent(e.target.value as Agent)}
          className="h-9 w-full rounded-[10px] border border-(--glass-border-hairline) bg-[color-mix(in_oklab,var(--color-bg-input)_70%,transparent)] px-3 text-[13px] backdrop-blur-md focus:border-(--color-accent-500) focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent-500)_25%,transparent)]"
        >
          {allAgents.map((a) => (
            <option key={a.agent} value={a.agent}>
              {a.label}
            </option>
          ))}
        </select>
        {activeAgent && (
          <code className="block truncate text-[11px] text-(--color-text-muted)">
            {activeAgent.command}
          </code>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Prompt
        </label>
        <GlassTextarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do?"
          rows={4}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        {createWorkspace.error && (
          <span className="mr-auto text-[11px] text-(--color-danger)">
            {String(createWorkspace.error)}
          </span>
        )}
        {showCancel && onCancel && (
          <GlassButton variant="ghost" size="sm" type="button" onClick={onCancel}>
            Cancel
          </GlassButton>
        )}
        <GlassButton
          variant="primary"
          size="sm"
          type="submit"
          disabled={createWorkspace.isPending || !name.trim() || !activeAgent}
        >
          {createWorkspace.isPending ? "Creating…" : submitLabel}
        </GlassButton>
      </div>
    </form>
  );
}
