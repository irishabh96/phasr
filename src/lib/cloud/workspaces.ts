import type { SupabaseClient } from "@supabase/supabase-js";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";
import { pushRepository } from "./repositories";

interface CloudWorkspaceRow {
  id: string;
  user_id: string;
  repository_id: string;
  name: string;
  prompt: string | null;
  agent_id: string | null;
  command: string;
  status: string;
  branch: string | null;
  worktree_path: string | null;
  exit_code: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  archived_at: string | null;
  updated_at: string;
}

export async function pushWorkspace(
  client: SupabaseClient,
  userId: string,
  workspace: Workspace,
): Promise<void> {
  // Pre-push the parent repository so the FK is always satisfied
  // (mirror dispatch runs all mutations concurrently).
  try {
    const repos = await tauri.listRepositories();
    const parent = repos.find((r) => r.id === workspace.repositoryId);
    if (parent) {
      await pushRepository(client, userId, parent);
    }
  } catch (err) {
    console.warn("[cloud] pre-push repository failed (continuing)", err);
  }

  // Seeded agents are local-only and are not stored in the cloud
  // `agents` table, so cloud workspaces keep a null FK. The workspace's
  // command snapshot still captures what to run.
  const cloudAgentIdForWorkspace: string | null = null;

  const { error } = await client.from("workspaces").upsert({
    id: workspace.id,
    user_id: userId,
    repository_id: workspace.repositoryId,
    name: workspace.name,
    prompt: workspace.prompt,
    agent_id: cloudAgentIdForWorkspace,
    command: workspace.command,
    status: workspace.status,
    branch: workspace.branch,
    worktree_path: workspace.worktreePath,
    exit_code: workspace.exitCode,
    created_at: workspace.createdAt,
    started_at: workspace.startedAt,
    finished_at: workspace.finishedAt,
    archived_at: workspace.archivedAt,
    updated_at: workspace.updatedAt,
  });
  if (error) throw error;
}

export async function deleteWorkspaceFromCloud(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("workspaces").delete().eq("id", id);
  if (error) throw error;
}

export async function pullWorkspaces(client: SupabaseClient): Promise<void> {
  const { data, error } = await client.from("workspaces").select("*");
  if (error) throw error;
  const rows = (data ?? []) as CloudWorkspaceRow[];

  const localRepos = new Set((await tauri.listRepositories()).map((r) => r.id));

  for (const row of rows) {
    if (!localRepos.has(row.repository_id)) {
      console.warn("skipping cloud workspace for missing repository", row.repository_id);
      continue;
    }
    try {
      const existing = await tauri.getWorkspace(row.id).catch(() => null);
      if (!existing) {
        await tauri.createWorkspace({
          repositoryId: row.repository_id,
          name: row.name,
          command: row.command,
          ...(row.prompt ? { prompt: row.prompt } : {}),
          ...(row.agent_id ? { agentId: row.agent_id } : {}),
        });
      } else if (Date.parse(row.updated_at) > Date.parse(existing.updatedAt)) {
        await tauri.updateWorkspace(row.id, {
          name: row.name,
          ...(row.prompt ? { prompt: row.prompt } : {}),
          ...(row.agent_id ? { agentId: row.agent_id } : {}),
          command: row.command,
          ...(row.branch ? { branch: row.branch } : {}),
          ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
          ...(row.exit_code != null ? { exitCode: row.exit_code } : {}),
        });
      }
    } catch (err) {
      console.warn("failed to materialise cloud workspace locally", row.id, err);
    }
  }
}

export async function pushMissingWorkspaces(
  client: SupabaseClient,
  userId: string,
): Promise<void> {
  const repos = await tauri.listRepositories();
  const { data: cloudRows } = await client.from("workspaces").select("id");
  const cloudIds = new Set((cloudRows ?? []).map((row) => row.id as string));

  for (const repo of repos) {
    const workspaces = await tauri.listWorkspaces(repo.id);
    for (const workspace of workspaces) {
      if (cloudIds.has(workspace.id)) continue;
      try {
        await pushWorkspace(client, userId, workspace);
      } catch (err) {
        console.warn("backfill workspace push failed", workspace.id, err);
      }
    }
  }
}
