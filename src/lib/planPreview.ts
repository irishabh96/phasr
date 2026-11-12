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

/** One line per mode for the New task picker. */
export const PERMISSION_HINT: Record<PermissionMode, string> = {
  "ask-edits": "Asks before editing files or running commands.",
  "ask-shell": "Edits files on its own; asks before running commands.",
  "skip-all": "Never asks. Edits and runs anything.",
};

export const RUN_IN_LABEL: Record<RunIn, string> = {
  worktree: "Worktree",
  "in-place": "In place",
};

/** One line per option for the New task "Runs in" popover. */
export const RUN_IN_HINT: Record<RunIn, string> = {
  worktree: "A fresh branch and folder; your checkout is untouched.",
  "in-place": "In your checkout, on its current branch.",
};

/** The branch a worktree task creates (New task's footer, the plan). */
export function taskBranch(name: string): string {
  return `phasr/${slugify(name) || "task"}`;
}

/**
 * The "plan" lines under New task (A-NewTask): what Phasr will actually do,
 * so the branch, worktree, agent command and any run command started with
 * the task are never a surprise.
 */
export function buildPlanPreview(input: {
  name: string;
  baseBranch: string;
  runIn: RunIn;
  agentCommand: string;
  worktreeBase?: string;
  /** The run command started alongside (New task's Run chip). */
  runCommand?: string | null;
}): { line: string; note?: string }[] {
  const where = input.runIn === "in-place" ? "in your checkout" : "in that worktree";
  const run = input.runCommand ? [{ line: input.runCommand, note: `${where}, alongside` }] : [];
  if (input.runIn === "in-place") {
    return [
      { line: input.agentCommand, note: "in your checkout, on its current branch" },
      ...run,
    ];
  }
  return [
    {
      line: `git worktree add ${input.worktreeBase ?? "~/.phasr/worktrees"}/<task> -b ${taskBranch(input.name)} ${input.baseBranch || "main"}`,
    },
    { line: input.agentCommand, note: where },
    ...run,
  ];
}
