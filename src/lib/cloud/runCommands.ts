import type { SupabaseClient } from "@supabase/supabase-js";
import { tauri } from "@/lib/tauri";
import type { RunCommand } from "@/lib/types";
import { pushRepository } from "./repositories";

interface CloudRunCommandRow {
  id: string;
  user_id: string;
  repository_id: string;
  name: string;
  command: string;
  shortcut: string | null;
  pinned: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function fromCloud(row: CloudRunCommandRow): RunCommand {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    name: row.name,
    command: row.command,
    shortcut: row.shortcut,
    pinned: row.pinned,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function pushRunCommand(
  client: SupabaseClient,
  userId: string,
  runCommand: RunCommand,
): Promise<void> {
  try {
    const repos = await tauri.listRepositories();
    const parent = repos.find((r) => r.id === runCommand.repositoryId);
    if (parent) {
      await pushRepository(client, userId, parent);
    }
  } catch (err) {
    console.warn("[cloud] pre-push repository for run command failed", err);
  }

  const { error } = await client.from("run_commands").upsert({
    id: runCommand.id,
    user_id: userId,
    repository_id: runCommand.repositoryId,
    name: runCommand.name,
    command: runCommand.command,
    shortcut: runCommand.shortcut,
    pinned: runCommand.pinned,
    sort_order: runCommand.sortOrder,
    created_at: runCommand.createdAt,
    updated_at: runCommand.updatedAt,
  });
  if (error) throw error;
}

export async function deleteRunCommandFromCloud(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("run_commands").delete().eq("id", id);
  if (error) throw error;
}

export async function pullRunCommands(client: SupabaseClient): Promise<void> {
  const { data, error } = await client.from("run_commands").select("*");
  if (error) throw error;
  const rows = (data ?? []) as CloudRunCommandRow[];

  const localRepos = new Set((await tauri.listRepositories()).map((r) => r.id));
  for (const row of rows) {
    if (!localRepos.has(row.repository_id)) {
      console.warn("skipping cloud run command for missing repository", row.repository_id);
      continue;
    }
    await tauri
      .upsertRunCommandFromCloud(fromCloud(row))
      .catch((err) => console.warn("failed to materialise cloud run command", row.id, err));
  }
}

export async function pushMissingRunCommands(
  client: SupabaseClient,
  userId: string,
): Promise<void> {
  const { data, error } = await client.from("run_commands").select("id, updated_at");
  if (error) throw error;
  const cloudUpdated = new Map(
    ((data ?? []) as Pick<CloudRunCommandRow, "id" | "updated_at">[]).map((row) => [
      row.id,
      row.updated_at,
    ]),
  );

  const repos = await tauri.listRepositories();
  for (const repo of repos) {
    const runCommands = await tauri.listRunCommands(repo.id);
    for (const runCommand of runCommands) {
      const cloudUpdatedAt = cloudUpdated.get(runCommand.id);
      if (cloudUpdatedAt && Date.parse(cloudUpdatedAt) >= Date.parse(runCommand.updatedAt)) {
        continue;
      }
      try {
        await pushRunCommand(client, userId, runCommand);
      } catch (err) {
        console.warn("backfill run command push failed", runCommand.id, err);
      }
    }
  }
}
