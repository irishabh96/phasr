import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { humanizeError } from "@/lib/humanizeError";
import { PERMISSION_LABEL } from "@/lib/planPreview";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type { Agent, PermissionMode, UnconfirmedSetting } from "@/lib/types";

export const unconfirmedSettingsKey = ["settings", "unconfirmed"] as const;

export type SyncedSettingsScope = "agentCommands" | "terminalShell" | "defaultPermissionMode";

/** The entries a banner for `scope` shows. Pure; exported for tests. */
export function settingsInScope(
  data: readonly UnconfirmedSetting[] | null | undefined,
  scope: SyncedSettingsScope,
): UnconfirmedSetting[] {
  return (Array.isArray(data) ? data : []).filter(
    (s) => !!s && typeof s.key === "string" && (s.key === scope || s.key.startsWith(`${scope}.`)),
  );
}

/** Human name for a setting key. */
export function settingLabel(key: string): string {
  if (key === "terminalShell") return "Terminal shell";
  if (key === "defaultPermissionMode") return "Default permission mode";
  const agent = key.startsWith("agentCommands.") ? key.slice("agentCommands.".length) : null;
  if (agent) {
    const label = (AGENT_META as Record<string, { label: string } | undefined>)[agent as Agent]?.label ?? agent;
    return `${label} command template`;
  }
  return key;
}

function displayValue(s: UnconfirmedSetting): string {
  if (s.key === "defaultPermissionMode") {
    const label = (PERMISSION_LABEL as Record<string, string | undefined>)[s.value as PermissionMode];
    return label ? `${label} (${s.value})` : s.value;
  }
  if (s.key === "terminalShell" && s.value === "") return "(login shell)";
  return s.value;
}

const UNTIL: Record<SyncedSettingsScope, string> = {
  agentCommands: "Until then the default template runs.",
  terminalShell: "Until then your login shell runs.",
  defaultPermissionMode: "Until then new tasks start in the safe default mode.",
};

/**
 * Settings that sync between devices and decide what runs here — agent
 * command templates, the terminal shell, the default permission mode — are
 * only used on this Mac after you allow them. Each value is shown in full
 * (monospace, truncated with an expander) and allowed on its own; "Allow
 * all shown" trusts exactly the listed values and nothing the banner
 * doesn't show. Hidden when there's nothing to confirm.
 */
export function SyncedSettingsBanner({ scope }: { scope: SyncedSettingsScope }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: unconfirmedSettingsKey,
    queryFn: () => tauri.listUnconfirmedSettings(),
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: (keys: string[]) => tauri.confirmSettingsOnThisMachine(keys),
    onSuccess: () => void qc.invalidateQueries({ queryKey: unconfirmedSettingsKey }),
    onError: (err) => showToast({ intent: "error", title: "Couldn't allow the setting", message: humanizeError(err) }),
  });
  const pending = settingsInScope(data, scope);
  if (pending.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Settings from another device"
      className="flex flex-col gap-2 rounded-(--radius-card) bg-(--color-warning-tint) px-3.5 py-2.5 text-[12px]"
    >
      <span className="text-(--color-text-secondary)">
        {pending.length === 1 ? "This setting" : "These settings"} came from another device and{" "}
        {pending.length === 1 ? "isn't" : "aren't"} used here until you allow {pending.length === 1 ? "it" : "them"}.{" "}
        {UNTIL[scope]}
      </span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {pending.map((s) => (
          <SettingRow
            key={s.key}
            setting={s}
            busy={confirm.isPending}
            onAllow={() => confirm.mutate([s.key])}
          />
        ))}
      </ul>
      {pending.length > 1 ? (
        <span className="flex justify-end">
          <Button
            size="sm"
            variant="primary"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate(pending.map((s) => s.key))}
          >
            Allow all shown
          </Button>
        </span>
      ) : null}
    </div>
  );
}

function SettingRow({
  setting,
  busy,
  onAllow,
}: {
  setting: UnconfirmedSetting;
  busy: boolean;
  onAllow: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const value = displayValue(setting);
  const long = value.length > 60 || value.includes("\n");
  return (
    <li className="flex items-start gap-2 rounded-(--radius-control) bg-(--color-bg-input) px-2.5 py-1.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] text-(--color-text-muted)">{settingLabel(setting.key)}</span>
        <code
          title={expanded ? undefined : value}
          className={
            expanded
              ? "block whitespace-pre-wrap break-all font-mono text-[12px] text-(--color-text-primary)"
              : "block truncate whitespace-pre font-mono text-[12px] text-(--color-text-primary)"
          }
        >
          {value}
        </code>
        {long ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="self-start text-[12px] text-(--color-text-muted) underline-offset-2 hover:text-(--color-text-secondary) hover:underline focus-visible:outline-none focus-visible:underline"
          >
            {expanded ? "Show less" : "Show full value"}
          </button>
        ) : null}
      </span>
      <Button size="sm" disabled={busy} onClick={onAllow} aria-label={`Allow ${settingLabel(setting.key)} on this Mac`}>
        Allow
      </Button>
    </li>
  );
}
