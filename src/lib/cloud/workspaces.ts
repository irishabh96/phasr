import type { SupabaseClient } from "@supabase/supabase-js";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";
import { getMachineId } from "@/lib/supabase";

interface CloudWorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  remote_url: string | null;
  local_paths: Record<string, string>;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

function pickLocalPath(row: CloudWorkspaceRow): string | null {
  return row.local_paths[getMachineId()] ?? null;
}

/**
 * Mirrors a locally-created or -updated workspace to the cloud. Adds
 * the current machine's local path under its machine id so other
 * machines don't see this device's path.
 */
export async function pushWorkspace(
  client: SupabaseClient,
  userId: string,
  workspace: Workspace,
): Promise<void> {
  const machineId = getMachineId();
  // Fetch existing local_paths to preserve other machines' entries.
  const { data: existing } = await client
    .from("workspaces")
    .select("local_paths")
    .eq("id", workspace.id)
    .maybeSingle();
  const localPaths: Record<string, string> = {
    ...((existing?.local_paths as Record<string, string> | null) ?? {}),
  };
  if (workspace.localPath) {
    localPaths[machineId] = workspace.localPath;
  }

  const { error } = await client.from("workspaces").upsert({
    id: workspace.id,
    user_id: userId,
    name: workspace.name,
    remote_url: workspace.remoteUrl,
    local_paths: localPaths,
    default_branch: workspace.defaultBranch,
    created_at: workspace.createdAt,
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

/** Push every local workspace that's missing from the cloud. */
export async function pushMissingWorkspaces(
  client: SupabaseClient,
  userId: string,
  cloudIds: Set<string>,
): Promise<void> {
  const locals = await tauri.listWorkspaces();
  for (const ws of locals) {
    if (cloudIds.has(ws.id)) continue;
    try {
      await pushWorkspace(client, userId, ws);
    } catch (err) {
      console.warn("backfill workspace push failed", ws.id, err);
    }
  }
}

/**
 * Pulls all workspaces for the signed-in user and upserts them into
 * local SQLite. Returns the set of cloud workspace ids so callers can
 * detect local-only ones that should be pushed up.
 */
export async function pullWorkspaces(client: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await client
    .from("workspaces")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as CloudWorkspaceRow[];

  const localList = await tauri.listWorkspaces();
  const localById = new Map(localList.map((w) => [w.id, w]));

  for (const row of rows) {
    const localPath = pickLocalPath(row);
    const local = localById.get(row.id);
    if (!local) {
      // Cloud-only: create locally with this machine's local_path (or
      // null if cloud didn't have one for us).
      try {
        await tauri.createWorkspace({
          name: row.name,
          ...(localPath ? { localPath } : {}),
          ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
        });
        // Note: createWorkspace generates a fresh UUID locally. We
        // accept that drift for Phase 6 MVP — Phase 7 will add an
        // upsert-by-id Tauri command so cloud IDs stay authoritative.
      } catch (err) {
        console.warn("failed to materialise cloud workspace locally", row.id, err);
      }
    } else if (Date.parse(row.updated_at) > Date.parse(local.updatedAt)) {
      // Cloud is newer.
      await tauri
        .updateWorkspace(local.id, {
          name: row.name,
          ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
          ...(localPath ? { localPath } : {}),
          defaultBranch: row.default_branch,
        })
        .catch((err) => console.warn("workspace update failed", err));
    }
  }
  return new Set(rows.map((r) => r.id));
}
