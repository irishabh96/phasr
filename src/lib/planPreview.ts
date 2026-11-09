import { slugify } from "@/lib/slug";
import type { PermissionMode, RunIn } from "@/lib/types";

/**
 * Task name derived from the prompt when the user doesn't type one: the
 * first sentence, trimmed to a few words ("Fix the login redirect bug: …"
 * → "fix the login redirect bug").
 */
export function nameFromPrompt(prompt: string): string {
  const first = prompt.trim().split(/[.:\n!?]/)[0] ?? "";
  const words = first.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.join(" ").toLowerCase();
}

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  "ask-edits": "Ask for edits",
  "ask-shell": "Ask for shell",
  "skip-all": "Skip all",
};

/**
 * The "plan" lines under New task (A-NewTask): what Phasr will actually do,
 * so the branch, worktree and agent command are never a surprise.
 */
export function buildPlanPreview(input: {
  name: string;
  baseBranch: string;
  runIn: RunIn;
  agentCommand: string;
  worktreeBase?: string;
}): { line: string; note?: string }[] {
  const slug = slugify(input.name) || "task";
  const branch = `phasr/${slug}`;
  if (input.runIn === "in-place") {
    return [
      { line: input.agentCommand, note: "in your checkout, on its current branch" },
    ];
  }
  return [
    {
      line: `git worktree add ${input.worktreeBase ?? "~/.phasr/worktrees"}/<task> -b ${branch} ${input.baseBranch || "main"}`,
    },
    { line: input.agentCommand, note: "in that worktree" },
  ];
}
