import type { SupabaseClient } from "@supabase/supabase-js";
import { tauri } from "@/lib/tauri";
import type { UserSettings } from "@/lib/types";

export async function pushUserSettings(
  client: SupabaseClient,
  userId: string,
  settings: UserSettings,
): Promise<void> {
  // `keyboard_shortcuts` and `disabled_agent_ids` are stored as JSON
  // strings locally but as jsonb in the cloud schema, so we parse on
  // the way out.
  const parsedShortcuts = safeJson(settings.keyboardShortcuts) ?? {};
  const parsedDisabled = safeJson(settings.disabledAgentIds) ?? [];

  const { error } = await client.from("user_settings").upsert({
    user_id: userId,
    theme: settings.theme,
    accent_color: settings.accentColor,
    sans_font: settings.sansFont,
    mono_font: settings.monoFont,
    base_font_size: settings.baseFontSize,
    cursor_style: settings.cursorStyle,
    cursor_blink: settings.cursorBlink,
    terminal_scrollback: settings.terminalScrollback,
    default_editor: settings.defaultEditor,
    default_terminal: settings.defaultTerminal,
    default_agent_id: settings.defaultAgentId,
    keyboard_shortcuts: parsedShortcuts,
    disabled_agent_ids: parsedDisabled,
    branch_prefix_template: settings.branchPrefixTemplate,
    worktree_base_path: settings.worktreeBasePath,
    default_merge_strategy: settings.defaultMergeStrategy,
    auto_fetch_seconds: settings.autoFetchSeconds,
    honor_gpg_sign: settings.honorGpgSign,
    auto_push_on_commit: settings.autoPushOnCommit,
    updated_at: settings.updatedAt,
  });
  if (error) throw error;
}

export async function pullUserSettings(
  client: SupabaseClient,
): Promise<void> {
  const { data, error } = await client
    .from("user_settings")
    .select("*")
    .maybeSingle();
  if (error) {
    console.warn("[cloud] pull user_settings failed", error);
    return;
  }
  if (!data) return;

  const local = await tauri.getUserSettings();
  if (Date.parse(data.updated_at as string) <= Date.parse(local.updatedAt)) {
    return; // local is at least as fresh
  }

  const next = {
    ...local,
    theme: data.theme as string,
    accentColor: data.accent_color as string,
    sansFont: data.sans_font as string,
    monoFont: data.mono_font as string,
    baseFontSize: data.base_font_size as number,
    cursorStyle: data.cursor_style as string,
    cursorBlink: data.cursor_blink as boolean,
    terminalScrollback: data.terminal_scrollback as number,
    defaultEditor: data.default_editor as string,
    defaultTerminal: data.default_terminal as string,
    defaultAgentId: (data.default_agent_id as string | null) ?? null,
    keyboardShortcuts: JSON.stringify(data.keyboard_shortcuts ?? {}),
    disabledAgentIds: JSON.stringify(data.disabled_agent_ids ?? []),
    branchPrefixTemplate: data.branch_prefix_template as string,
    worktreeBasePath: data.worktree_base_path as string,
    defaultMergeStrategy: data.default_merge_strategy as string,
    autoFetchSeconds: data.auto_fetch_seconds as number,
    honorGpgSign: data.honor_gpg_sign as boolean,
    autoPushOnCommit: data.auto_push_on_commit as boolean,
    updatedAt: data.updated_at as string,
  };
  await tauri.updateUserSettings(next).catch((err) => {
    console.warn("user_settings local upsert failed", err);
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
