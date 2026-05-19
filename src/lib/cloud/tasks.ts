import type { SupabaseClient } from "@supabase/supabase-js";
import { tauri } from "@/lib/tauri";
import type { Task } from "@/lib/types";
import { pushWorkspace } from "./workspaces";

interface CloudTaskRow {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  prompt: string | null;
  preset_id: string | null;
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

/** Push every local task whose row isn't in the cloud yet. */
export async function pushMissingTasks(
  client: SupabaseClient,
  userId: string,
): Promise<void> {
  const workspaces = await tauri.listWorkspaces();
  // Read all cloud task ids first to avoid one round-trip per task.
  const { data: cloudRows } = await client.from("tasks").select("id");
  const cloudIds = new Set((cloudRows ?? []).map((row) => row.id as string));

  for (const ws of workspaces) {
    const tasks = await tauri.listTasks(ws.id);
    for (const task of tasks) {
      if (cloudIds.has(task.id)) continue;
      try {
        await pushTask(client, userId, task);
      } catch (err) {
        console.warn("backfill task push failed", task.id, err);
      }
    }
  }
}

export async function pushTask(
  client: SupabaseClient,
  userId: string,
  task: Task,
): Promise<void> {
  // Ensure the parent workspace is in cloud before pushing the task —
  // workspace upserts and task upserts run concurrently from the
  // mutation cache subscriber, so without this we'd race on the FK.
  try {
    const workspaces = await tauri.listWorkspaces();
    const parent = workspaces.find((w) => w.id === task.workspaceId);
    if (parent) {
      await pushWorkspace(client, userId, parent);
    }
  } catch (err) {
    console.warn("[cloud] pre-push workspace failed (continuing)", err);
  }

  const { error } = await client.from("tasks").upsert({
    id: task.id,
    user_id: userId,
    workspace_id: task.workspaceId,
    name: task.name,
    prompt: task.prompt,
    // Phase 6 doesn't sync presets to the cloud yet — seeded presets
    // are generated with fresh UUIDs per machine so cross-device
    // FK references won't line up. We deliberately drop the linkage
    // here. Phase 7 will sync presets with deterministic IDs.
    preset_id: null,
    command: task.command,
    status: task.status,
    branch: task.branch,
    worktree_path: task.worktreePath,
    exit_code: task.exitCode,
    created_at: task.createdAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    archived_at: task.archivedAt,
    updated_at: task.updatedAt,
  });
  if (error) throw error;
}

export async function deleteTaskFromCloud(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("tasks").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Pulls remote tasks for each workspace the user has access to and
 * upserts them locally. Skipped (with a warning) for tasks whose
 * workspace isn't present locally yet — workspaces are pulled first
 * by the caller so this should be rare.
 */
export async function pullTasks(client: SupabaseClient): Promise<void> {
  const { data, error } = await client.from("tasks").select("*");
  if (error) throw error;
  const rows = (data ?? []) as CloudTaskRow[];

  const localWorkspaces = new Set((await tauri.listWorkspaces()).map((w) => w.id));

  for (const row of rows) {
    if (!localWorkspaces.has(row.workspace_id)) {
      console.warn("skipping cloud task for missing workspace", row.workspace_id);
      continue;
    }
    try {
      // We don't have a tauri "get task" that returns null on miss, so
      // we just attempt an update — if the row doesn't exist locally,
      // create it. Phase 7 will swap this for an upsert command.
      const existing = await tauri.getTask(row.id).catch(() => null);
      if (!existing) {
        await tauri.createTask({
          workspaceId: row.workspace_id,
          name: row.name,
          command: row.command,
          ...(row.prompt ? { prompt: row.prompt } : {}),
          ...(row.preset_id ? { presetId: row.preset_id } : {}),
        });
      } else if (Date.parse(row.updated_at) > Date.parse(existing.updatedAt)) {
        await tauri.updateTask(row.id, {
          name: row.name,
          ...(row.prompt ? { prompt: row.prompt } : {}),
          ...(row.preset_id ? { presetId: row.preset_id } : {}),
          command: row.command,
          ...(row.branch ? { branch: row.branch } : {}),
          ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
          ...(row.exit_code != null ? { exitCode: row.exit_code } : {}),
        });
      }
    } catch (err) {
      console.warn("failed to materialise cloud task locally", row.id, err);
    }
  }
}
