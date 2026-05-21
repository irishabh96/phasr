import type { SupabaseClient } from "@supabase/supabase-js";
import { tauri } from "@/lib/tauri";
import type { Repository } from "@/lib/types";
import { getMachineId } from "@/lib/supabase";

interface CloudRepositoryRow {
  id: string;
  user_id: string;
  name: string;
  remote_url: string | null;
  local_paths: Record<string, string>;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

function pickLocalPath(row: CloudRepositoryRow): string | null {
  return row.local_paths[getMachineId()] ?? null;
}

export async function pushRepository(
  client: SupabaseClient,
  userId: string,
  repository: Repository,
): Promise<void> {
  const machineId = getMachineId();
  const { data: existing } = await client
    .from("repositories")
    .select("local_paths")
    .eq("id", repository.id)
    .maybeSingle();
  const localPaths: Record<string, string> = {
    ...((existing?.local_paths as Record<string, string> | null) ?? {}),
  };
  if (repository.localPath) {
    localPaths[machineId] = repository.localPath;
  }

  const { error } = await client.from("repositories").upsert({
    id: repository.id,
    user_id: userId,
    name: repository.name,
    remote_url: repository.remoteUrl,
    local_paths: localPaths,
    default_branch: repository.defaultBranch,
    created_at: repository.createdAt,
    updated_at: repository.updatedAt,
  });
  if (error) throw error;
}

export async function deleteRepositoryFromCloud(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("repositories").delete().eq("id", id);
  if (error) throw error;
}

export async function pullRepositories(client: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await client
    .from("repositories")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as CloudRepositoryRow[];

  const localList = await tauri.listRepositories();
  const localById = new Map(localList.map((r) => [r.id, r]));

  for (const row of rows) {
    // Skip any cloud row whose id is soft-deleted locally. The local
    // tombstone wins — pushing the delete back up to cloud is the
    // bootstrap's earlier step (see useCloudSync); pulling must not
    // resurrect rows the user already removed.
    if (await tauri.repositoryIsSoftDeleted(row.id)) {
      continue;
    }

    const localPath = pickLocalPath(row);
    const local = localById.get(row.id);
    if (!local) {
      try {
        await tauri.createRepository({
          name: row.name,
          ...(localPath ? { localPath } : {}),
          ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
        });
      } catch (err) {
        console.warn("failed to materialise cloud repository locally", row.id, err);
      }
    } else if (Date.parse(row.updated_at) > Date.parse(local.updatedAt)) {
      await tauri
        .updateRepository(local.id, {
          name: row.name,
          ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
          ...(localPath ? { localPath } : {}),
          defaultBranch: row.default_branch,
        })
        .catch((err) => console.warn("repository update failed", err));
    }
  }
  return new Set(rows.map((r) => r.id));
}

/**
 * Best-effort push of any locally soft-deleted repositories whose
 * cloud delete hasn't completed yet. Called by the cloud-sync
 * bootstrap before the pull so a delete that failed to mirror on the
 * previous session doesn't resurrect on this one.
 *
 * On success per id: clear local `dirty` via `mark_repository_synced`.
 * On failure: leave the row tombstoned + dirty for next bootstrap.
 */
export async function pushPendingRepositoryDeletes(
  client: SupabaseClient,
): Promise<void> {
  const ids = await tauri.listSoftDeletedRepositories();
  for (const id of ids) {
    try {
      await deleteRepositoryFromCloud(client, id);
      await tauri.markRepositorySynced(id);
    } catch (err) {
      console.warn("pending repo delete push failed; will retry next session", id, err);
    }
  }
}

export async function pushMissingRepositories(
  client: SupabaseClient,
  userId: string,
  cloudIds: Set<string>,
): Promise<void> {
  const locals = await tauri.listRepositories();
  for (const repo of locals) {
    if (cloudIds.has(repo.id)) continue;
    try {
      await pushRepository(client, userId, repo);
    } catch (err) {
      console.warn("backfill repository push failed", repo.id, err);
    }
  }
}
