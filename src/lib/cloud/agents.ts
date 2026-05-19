import type { SupabaseClient } from "@supabase/supabase-js";
import { tauri } from "@/lib/tauri";

/**
 * Phase 7 cloud-sync model:
 *   - Seeded agents are hardcoded in the app with stable UUIDs (uuid_v5
 *     of name). They are NEVER pushed to the cloud `agents` table —
 *     there's no point: every install computes the same ID for
 *     "Claude". Workspace.agent_id can reference them without an FK
 *     row existing in cloud.
 *   - Only USER-CREATED custom agents go through this sync layer.
 */
export async function pushCustomAgents(
  client: SupabaseClient,
  userId: string,
): Promise<void> {
  const agents = await tauri.listAgents();
  for (const agent of agents) {
    if (agent.isSeed) continue;
    try {
      const { error } = await client.from("agents").upsert({
        id: agent.id,
        user_id: userId,
        name: agent.name,
        command: agent.command,
        icon: agent.icon,
        is_default: agent.isDefault,
        is_enabled: agent.isEnabled,
        is_seed: false,
        sort_order: agent.sortOrder,
        created_at: agent.createdAt,
        updated_at: agent.updatedAt,
      });
      if (error) throw error;
    } catch (err) {
      console.warn("custom agent push failed", agent.name, err);
    }
  }
}

/**
 * Pulls cloud `agents` (custom-only) and reconciles into local. For
 * Phase 7, custom agents are local-only on each install if not
 * already inserted — a dedicated `upsert_agent` Tauri command lands
 * later when the Settings → Agents page is built.
 */
export async function pullCustomAgents(_client: SupabaseClient): Promise<void> {
  // Placeholder — see comment above. Listing them just for parity.
  // Once we have a Tauri upsert command we'll materialize them.
}
