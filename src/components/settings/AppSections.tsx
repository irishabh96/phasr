import { Check, Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { SyncedSettingsBanner } from "./SyncedSettingsBanner";
import { readAutoCollapse, writeAutoCollapse } from "@/lib/hooks/useAutoCollapse";
import { useSuggestReplies, writeSuggestReplies } from "@/lib/transcript/suggestPref";
import { SettingsCard, SettingsRow } from "@/components/ui/SettingsRow";
import { GlassSelect } from "@/components/ui/GlassSelect";
import { agentKeys, useAgentDetection, useAgents } from "@/lib/hooks/useAgents";
import { useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import { PERMISSION_LABEL } from "@/lib/planPreview";
import type { ApiKeyName, NotificationKind, NotificationPrefs, PermissionMode } from "@/lib/types";
import { useApiKeys, useDeleteApiKey, useSetApiKey, useShells } from "@/lib/hooks/useRepositoryConfig";
import { DEFAULT_CHANNELS, DEFAULT_NOTIFICATION_PREFS } from "@/lib/notificationPolicy";
import {
  TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  useAdjustTerminalFontSize,
  useUpdateUserSettings,
  useUserSettings,
} from "@/lib/hooks/useUserSettings";
import {
  initNotificationPermissionState,
  osNotificationsGranted,
} from "@/lib/notificationPermission";
import { SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { normalizeCursorStyle } from "@/lib/terminal/options";
import type { TerminalCursorStyle } from "@/lib/terminal/surface";
import { ACCENTS, ACCENT_SWATCH, type Accent, type Theme } from "@/lib/theme";
import {
  type DesktopSession,
  readDesktopSession,
  signOutDesktopSession,
} from "@/lib/desktopAuth";
import { cn } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { humanizeError } from "@/lib/humanizeError";

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

function initials(session: DesktopSession) {
  const label = session.profile.name ?? session.profile.email ?? "Phasr";
  const parts = label.replace(/@.*/, "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0]?.slice(0, 2) || "P").toUpperCase();
}

export function AccountSection() {
  const session = readDesktopSession();
  if (!session) {
    return <p className="text-[12px] text-(--color-text-muted)">Loading account…</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      <SettingsCard>
        <div data-settings-row id="settings-row-profile" className="flex items-center gap-3 px-3.5 py-3">
          {session.profile.imageUrl ? (
            <img
              src={session.profile.imageUrl}
              alt=""
              className="size-9 rounded-full object-cover shadow-(--shadow-card)"
            />
          ) : (
            <span className="grid size-9 place-items-center rounded-full bg-(--color-success) text-[13px] font-semibold text-white">
              {initials(session)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">
              {session.profile.name ?? session.profile.email ?? "Signed in"}
            </div>
            <div className="truncate text-[12px] text-(--color-text-muted)">
              {session.profile.email ?? "Email not provided"} · verified desktop session
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          id="settings-row-sign-out"
          label="Sign out of this device"
          help="Ends this device's session. Your repositories and tasks stay on disk."
        >
          <Button
            variant="danger"
            onClick={() => {
              void signOutDesktopSession().then(() => {
                window.location.href = "/sign-in";
              });
            }}
          >
            Sign out
          </Button>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

const THEMES: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

/** Miniature app frame: sidebar strip + canvas, painted in the theme's own hexes. */
function ThemePreview({ theme }: { theme: Theme }) {
  if (theme === "system") {
    return (
      <span
        aria-hidden
        className="block h-14 rounded-[5px]"
        style={{
          background: "linear-gradient(110deg, #0C0C0E 50%, #F6F5F2 50%)",
          boxShadow: "0 0 0 1px var(--color-border-hairline)",
        }}
      />
    );
  }
  const dark = theme === "dark";
  return (
    <span
      aria-hidden
      className="flex h-14 overflow-hidden rounded-[5px]"
      style={{ background: dark ? "#0C0C0E" : "#F6F5F2", boxShadow: `0 0 0 1px ${dark ? "#26262C" : "#D9D4CB"}` }}
    >
      {/* Sidebar strip: a tone step, no line (A-Polish 01). */}
      <span className="w-[28%]" style={{ background: dark ? "#141417" : "#ECE8E1" }} />
    </span>
  );
}

export function AppearanceSection() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const accent = useUiStore((s) => s.accent);
  const setAccent = useUiStore((s) => s.setAccent);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const { data: settings } = useUserSettings();
  const { mutate } = useUpdateUserSettings();

  const pickAccent = (a: Accent) => {
    setAccent(a);
    if (settings && settings.accentColor !== a) mutate({ ...settings, accentColor: a });
  };

  return (
    <div className="flex flex-col gap-5">
      <section id="settings-row-theme" className="flex flex-col gap-2.5" aria-labelledby="appearance-theme">
        <h3 id="appearance-theme" className="group-header m-0">
          Theme
        </h3>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2.5">
          {THEMES.map((t) => {
            const active = theme === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(t.value)}
                className={cn(
                  "flex flex-col gap-2 rounded-(--radius-card) p-2 text-left shadow-(--shadow-card)",
                  "transition-colors duration-(--dur-1) ease-(--ease-out)",
                  "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
                  // Selected = a background step, never a coloured outline.
                  active ? "bg-(--color-bg-hover)" : "bg-(--color-bg-surface) hover:bg-(--color-bg-elevated)",
                )}
              >
                <ThemePreview theme={t.value} />
                <span className="flex items-center gap-1.5 text-[12px] font-medium">
                  {t.label}
                  <span className="flex-1" />
                  {active ? (
                    <span className="grid size-3.5 place-items-center rounded-full bg-(--color-accent-500) text-(--color-accent-onfill)">
                      <Check className="size-2.5" strokeWidth={3} aria-hidden />
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <div id="settings-row-accent" className="flex items-center gap-2.5">
          <span id="appearance-accent" className="w-40 text-[12px] text-(--color-text-secondary)">
            Accent
          </span>
          <div role="radiogroup" aria-labelledby="appearance-accent" className="flex gap-1.5">
            {ACCENTS.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={accent === a}
                aria-label={a[0]!.toUpperCase() + a.slice(1)}
                onClick={() => pickAccent(a)}
                className="size-[22px] rounded-full border-2 transition-[border-color] focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                style={{
                  background: ACCENT_SWATCH[a],
                  borderColor: accent === a ? "var(--color-text-primary)" : "transparent",
                }}
              />
            ))}
          </div>
        </div>
      </section>

      <SettingsCard>
        <AutoCollapseRow />
        <SettingsRow
          id="settings-row-density"
          label="Interface density"
          help="Row heights in lists, board and inspector"
        >
          <SegmentedControl
            label="Interface density"
            value={density}
            onChange={setDensity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

function AutoCollapseRow() {
  const [on, setOn] = useState(readAutoCollapse);
  return (
    <SettingsRow
      id="settings-row-auto-collapse"
      label="Fold side panels on narrow windows"
      help="Below 1360 px the task list and inspector collapse to rails."
    >
      <Switch
        checked={on}
        label="Fold side panels on narrow windows"
        onChange={(v) => {
          setOn(v);
          writeAutoCollapse(v);
        }}
      />
    </SettingsRow>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal                                                            */
/* ------------------------------------------------------------------ */

/** Bundled first; the rest render when installed and fall back otherwise. */
const MONO_FONTS = ["JetBrains Mono", "SF Mono", "Menlo", "Fira Code", "Cascadia Code"];

const SCROLLBACK: { value: string; label: string; lines: number }[] = [
  { value: "unlimited", label: "Unlimited", lines: 0 },
  // 10000 is the legacy never-chosen default (read as unlimited), so a
  // deliberate 10k is stored as 10001 — see terminal/options.ts.
  { value: "10k", label: "10k", lines: 10001 },
  { value: "100k", label: "100k", lines: 100000 },
];

function scrollbackChoice(lines: number | undefined): string {
  if (!lines || lines === 10000) return "unlimited";
  if (lines <= 10001) return "10k";
  return "100k";
}

export function TerminalSection() {
  const { data: settings } = useUserSettings();
  const { mutate } = useUpdateUserSettings();
  const adjust = useAdjustTerminalFontSize();
  const size = settings ? clampTerminalFontSize(settings.baseFontSize) : null;
  const style = settings ? normalizeCursorStyle(settings.cursorStyle) : null;
  const { data: shells } = useShells();

  return (
    <div className="flex flex-col gap-3">
    <SyncedSettingsBanner scope="terminalShell" />
    <SettingsCard title="Terminal">
      <SettingsRow id="settings-row-font" label="Font" help="Monospace face for every terminal" htmlFor="st-font">
        <GlassSelect
          id="st-font"
          className="w-[200px] font-mono"
          disabled={!settings}
          value={settings?.monoFont || "JetBrains Mono"}
          onChange={(e) => settings && mutate({ ...settings, monoFont: e.target.value })}
          options={MONO_FONTS.map((f) => ({ label: f, value: f }))}
        />
      </SettingsRow>
      <SettingsRow
        id="settings-row-font-size"
        label="Font size"
        help={
          <>
            {SHORTCUTS.increaseFontSize.display.join(" ")} / {SHORTCUTS.decreaseFontSize.display.join(" ")} anywhere ·{" "}
            {SHORTCUTS.resetFontSize.display.join(" ")} resets
          </>
        }
      >
        <div className="flex items-center overflow-hidden rounded-(--radius-control) bg-(--color-bg-input) shadow-(--ring-input)">
          <button
            type="button"
            aria-label={SHORTCUTS.decreaseFontSize.label}
            disabled={size === null || size <= TERMINAL_FONT_SIZE.min}
            onClick={() => adjust(-1)}
            className="grid size-7 place-items-center text-(--color-text-secondary) transition-colors duration-(--dur-1) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)"
          >
            <Minus className="size-3" aria-hidden />
          </button>
          <span role="status" aria-atomic="true" className="w-[52px] text-center text-[12px] tabular-nums">
            {size === null ? "—" : `${size} px`}
          </span>
          <button
            type="button"
            aria-label={SHORTCUTS.increaseFontSize.label}
            disabled={size === null || size >= TERMINAL_FONT_SIZE.max}
            onClick={() => adjust(1)}
            className="grid size-7 place-items-center text-(--color-text-secondary) transition-colors duration-(--dur-1) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)"
          >
            <Plus className="size-3" aria-hidden />
          </button>
        </div>
      </SettingsRow>
      <SettingsRow id="settings-row-cursor" label="Cursor" help="Shape and blink">
        <SegmentedControl<TerminalCursorStyle>
          label="Cursor shape"
          value={style ?? "block"}
          onChange={(v) => settings && mutate({ ...settings, cursorStyle: v })}
          options={[
            { value: "block", label: "Block", disabled: !settings },
            { value: "bar", label: "Bar", disabled: !settings },
            { value: "underline", label: "Underline", disabled: !settings },
          ]}
        />
        <label className="flex items-center gap-2 text-[12px] text-(--color-text-secondary)">
          <input
            type="checkbox"
            className="size-3.5 accent-(--color-accent-500) p-0"
            disabled={!settings}
            checked={settings?.cursorBlink ?? true}
            onChange={() => settings && mutate({ ...settings, cursorBlink: !settings.cursorBlink })}
          />
          Blink
        </label>
      </SettingsRow>
      <SettingsRow id="settings-row-shell" label="Shell" help="For plain terminal panes and agents" htmlFor="st-shell">
        <GlassSelect
          id="st-shell"
          className="w-[200px] font-mono"
          disabled={!settings}
          value={settings?.terminalShell ?? ""}
          onChange={(e) => settings && mutate({ ...settings, terminalShell: e.target.value })}
          options={[
            { label: "Login shell ($SHELL)", value: "" },
            ...(shells ?? []).map((sh) => ({ label: sh, value: sh })),
          ]}
        />
      </SettingsRow>
      <SettingsRow id="settings-row-copy-on-select" label="Copy on select" help="Selecting text in a terminal copies it">
        <Switch
          label="Copy on select"
          disabled={!settings}
          checked={!!settings?.copyOnSelect}
          onChange={(v) => settings && mutate({ ...settings, copyOnSelect: v })}
        />
      </SettingsRow>
      <SettingsRow id="settings-row-scrollback" label="Scrollback" help="Lines kept per pane">
        <SegmentedControl
          label="Scrollback"
          value={scrollbackChoice(settings?.terminalScrollback)}
          onChange={(v) => {
            const pick = SCROLLBACK.find((s) => s.value === v);
            if (settings && pick) mutate({ ...settings, terminalScrollback: pick.lines });
          }}
          options={SCROLLBACK.map((s) => ({ value: s.value, label: s.label, disabled: !settings }))}
        />
      </SettingsRow>
    </SettingsCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Agents & keys                                                       */
/* ------------------------------------------------------------------ */

export function AgentsSection() {
  const { data: agents, isLoading } = useAgents();
  const detection = useAgentDetection();
  const qc = useQueryClient();
  const [redetecting, setRedetecting] = useState(false);
  const { data: settings } = useUserSettings();
  const { mutate } = useUpdateUserSettings();

  const redetect = async () => {
    setRedetecting(true);
    try {
      const fresh = await tauri.detectAgents(true);
      qc.setQueryData([...agentKeys.all, "detection"], fresh);
    } finally {
      setRedetecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <div
          data-settings-row
          id="settings-row-agents"
          className="grid grid-cols-[140px_minmax(0,1fr)_110px] items-center gap-3 px-3.5 py-2"
        >
          <span className="group-header">Agent</span>
          <span className="group-header">Command</span>
          <span className="flex items-center justify-end">
            <Button variant="ghost" size="sm" className="-mr-2 h-6" disabled={redetecting} onClick={() => void redetect()}>
              {redetecting ? "Detecting…" : "Re-detect"}
            </Button>
          </span>
        </div>
        {isLoading ? (
          <div data-settings-row className="px-3.5 py-3 text-[12px] text-(--color-text-muted)">
            Loading…
          </div>
        ) : null}
        {agents?.map((a) => {
          const det = detection.data?.find((d) => d.agent === a.agent);
          return (
            <div
              key={a.agent}
              data-settings-row
              className="grid grid-cols-[140px_minmax(0,1fr)_110px] items-center gap-3 px-3.5 py-2.5"
            >
              <span className="flex items-center gap-2 text-[12px] font-medium">
                <AgentMark agent={a.agent} size="md" withLabel />
                {a.isDefault ? <span className="text-[12px] font-normal text-(--color-text-muted)">default</span> : null}
              </span>
              <code className="truncate font-mono text-[11px] text-(--color-text-secondary)" title={a.template ?? a.command}>
                {a.template ?? a.command}
              </code>
              <span className="truncate text-right font-mono text-[11px]">
                {!det ? (
                  <span className="text-(--color-text-muted)">{detection.isLoading ? "…" : ""}</span>
                ) : det.status === "found" ? (
                  <span className="text-(--color-success)">{det.version ?? "found"} ✓</span>
                ) : det.status === "missing" ? (
                  <span className="text-(--color-text-muted)" title={det.installHint}>
                    not found
                  </span>
                ) : (
                  <span className="text-(--color-warning)">{det.status}</span>
                )}
              </span>
            </div>
          );
        })}
      </SettingsCard>
      <SyncedSettingsBanner scope="agentCommands" />
      <ApiKeysCard />
      <SyncedSettingsBanner scope="defaultPermissionMode" />
      <SettingsCard>
        <SettingsRow
          id="settings-row-permission-mode"
          label="Default permission mode for new tasks"
          help="Can be changed per task. Agents that can't ask fall back to the nearest mode they support."
        >
          <SegmentedControl<PermissionMode>
            label="Default permission mode"
            value={settings?.defaultPermissionMode ?? "ask-shell"}
            onChange={(m) => settings && mutate({ ...settings, defaultPermissionMode: m })}
            options={(["ask-shell", "ask-edits", "skip-all"] as PermissionMode[]).map((m) => ({
              value: m,
              label: PERMISSION_LABEL[m],
              disabled: !settings,
              ...(m === "skip-all" ? { tone: "warning" as const } : {}),
            }))}
          />
        </SettingsRow>
        <SuggestRepliesRow />
      </SettingsCard>
    </div>
  );
}

/** Transcript view's composer chips: off = only what the conversation itself suggests, no Haiku call. */
function SuggestRepliesRow() {
  const on = useSuggestReplies();
  return (
    <SettingsRow
      id="settings-row-suggest-replies"
      label="Suggest replies"
      help="After each turn, a quick Haiku call through your Claude login suggests what to say next (≈$0.001 per turn). Off: suggestions come only from the conversation itself."
    >
      <Switch checked={on} label="Suggest replies" onChange={writeSuggestReplies} />
    </SettingsRow>
  );
}

const KEY_AGENT: Record<ApiKeyName, string> = {
  ANTHROPIC_API_KEY: "Claude",
  OPENAI_API_KEY: "Codex",
  GEMINI_API_KEY: "Gemini",
};

/** API keys in the macOS Keychain, never synced; injected only into that agent. */
function ApiKeysCard() {
  const { data: keys } = useApiKeys();
  const setKey = useSetApiKey();
  const delKey = useDeleteApiKey();
  const [editing, setEditingRaw] = useState<ApiKeyName | null>(null);
  const [value, setValue] = useState("");
  const [removing, setRemoving] = useState<ApiKeyName | null>(null);
  // A typed key never carries over to another provider's field.
  const setEditing = (name: ApiKeyName | null) => {
    setValue("");
    setEditingRaw(name);
  };
  if (!keys) return null;
  return (
    <SettingsCard title="API keys · stored in macOS Keychain, never synced">
      {keys.map((k) => (
        <div key={k.name} data-settings-row id={`settings-row-${k.name}`} className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-mono text-[12px]">{k.name}</span>
            <span className="text-[12px] text-(--color-text-muted)">
              {k.isSet ? `${KEY_AGENT[k.name]} uses this key (API billing)` : `not set · ${KEY_AGENT[k.name]} uses its own login`}
            </span>
          </span>
          {editing === k.name ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!value.trim()) return;
                setKey.mutate(
                  { name: k.name, value: value.trim() },
                  {
                    onSuccess: () => setEditing(null),
                    onError: (err) => showToast({ intent: "error", title: "Couldn't store the key", message: humanizeError(err) }),
                  },
                );
              }}
            >
              <input
                type="password"
                autoFocus
                aria-label={`${k.name} value`}
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-7 w-[220px] px-2 py-0 font-mono text-[12px]"
              />
              <Button size="sm" type="submit" variant="primary" disabled={!value.trim() || setKey.isPending}>
                Save
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <>
              {k.isSet ? <span className="font-mono text-[11px] text-(--color-text-muted)">••••••••{k.hint ?? ""}</span> : null}
              <Button variant="ghost" size="sm" onClick={() => setEditing(k.name)}>
                {k.isSet ? "Replace" : "+ Add"}
              </Button>
              {k.isSet ? (
                <Button size="sm" variant="ghost" disabled={delKey.isPending} onClick={() => setRemoving(k.name)}>
                  Remove
                </Button>
              ) : null}
            </>
          )}
        </div>
      ))}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing ?? ""}?`}
        description="The key is deleted from your macOS Keychain. The agent falls back to its own login."
        confirmLabel="Remove key"
        destructive
        onConfirm={() => {
          if (removing) delKey.mutate(removing);
          setRemoving(null);
        }}
      />
    </SettingsCard>
  );
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

const KEYBOARD_GROUPS: { title: string; ids: (keyof typeof SHORTCUTS)[] }[] = [
  {
    title: "Global",
    ids: ["togglePalette", "newWorkspace", "newTerminal", "openNotes", "openSettings", "searchFiles"],
  },
  {
    title: "In a session",
    ids: [
      "reviewChanges",
      "stopAgent",
      "approveAgent",
      "denyAgent",
      "dictate",
      "toggleRightPanel",
      "toggleSidebarPin",
      "toggleSidebarHide",
      "closeActiveTab",
    ],
  },
  {
    title: "Terminal",
    ids: ["increaseFontSize", "decreaseFontSize", "resetFontSize"],
  },
  { title: "Review", ids: ["toggleDiffMode", "commitAndPush", "submitForm"] },
];

function KeyCombo({ s }: { s: Shortcut }) {
  return (
    <span className="flex items-center gap-1">
      <Kbd>{s.display.join("")}</Kbd>
    </span>
  );
}

export function KeyboardSection() {
  return (
    <div id="settings-row-shortcuts" className="flex flex-col gap-4">
      {KEYBOARD_GROUPS.map((g) => (
        <SettingsCard key={g.title} title={g.title}>
          {g.ids.map((id) => {
            const s = SHORTCUTS[id] as Shortcut;
            return (
              <SettingsRow key={id} label={s.label}>
                <KeyCombo s={s} />
              </SettingsRow>
            );
          })}
        </SettingsCard>
      ))}
      <p className="m-0 text-[12px] text-(--color-text-muted)">
        Shortcuts never fire while a terminal pane has focus unless they include ⌘ — so agent TUIs keep their own keys.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

const NOTIFICATION_ROWS: { kind: NotificationKind; label: string; help: string }[] = [
  { kind: "needs_approval", label: "Agent needs approval", help: "Shell command, edit, or a question for you" },
  { kind: "task_finished", label: "Task finished · ready for review", help: "" },
  { kind: "task_failed", label: "Task failed or agent exited", help: "" },
  { kind: "checks_finished", label: "Checks finished on a review", help: "" },
  { kind: "run_command_failed", label: "Run command exited non-zero", help: "" },
];

const ALERTS_HINT_KEY = "phasr.hint.notificationAlertsStyle";

/**
 * Shown until dismissed: the needs-you banner's Allow / Deny buttons only
 * stay on screen when macOS shows Phasr's notifications as Alerts — a
 * per-app setting Phasr can't change or read.
 */
function AlertsStyleHint() {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(ALERTS_HINT_KEY) === "1",
  );
  if (dismissed) return null;
  return (
    <SettingsRow
      id="settings-row-alerts-style"
      label="Allow or deny from the notification"
      help="So the buttons stay on screen until you answer, set Phasr's style to Alerts in System Settings › Notifications › Phasr."
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          window.localStorage.setItem(ALERTS_HINT_KEY, "1");
          setDismissed(true);
        }}
      >
        Got it
      </Button>
    </SettingsRow>
  );
}

export function NotificationsSection() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const { data: settings } = useUserSettings();
  const { mutate } = useUpdateUserSettings();
  useEffect(() => {
    void initNotificationPermissionState().then(() => setGranted(osNotificationsGranted()));
  }, []);
  const prefs: NotificationPrefs = settings?.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS;
  const save = (next: NotificationPrefs) => settings && mutate({ ...settings, notificationPrefs: next });
  const channel = (kind: NotificationKind) => prefs.matrix[kind] ?? DEFAULT_CHANNELS[kind];
  return (
    <div className="flex flex-col gap-4">
    <SettingsCard>
      <div
        data-settings-row
        id="settings-row-matrix"
        className="grid grid-cols-[minmax(0,1fr)_56px_56px_56px] items-center gap-2 bg-(--color-bg-sidebar) px-3.5 py-2"
      >
        <span className="group-header">Event</span>
        <span className="group-header text-center">Badge</span>
        <span className="group-header text-center">System</span>
        <span className="group-header text-center">Sound</span>
      </div>
      {NOTIFICATION_ROWS.map((row) => {
        const c = channel(row.kind);
        return (
          <div
            key={row.kind}
            data-settings-row
            className="grid grid-cols-[minmax(0,1fr)_56px_56px_56px] items-center gap-2 px-3.5 py-2.5"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium">{row.label}</span>
              {row.help ? <span className="text-[12px] text-(--color-text-muted)">{row.help}</span> : null}
            </span>
            {(["badge", "system", "sound"] as const).map((ch) => (
              <span key={ch} className="flex justify-center">
                <input
                  type="checkbox"
                  aria-label={`${row.label}: ${ch}`}
                  className="size-3.5 p-0 accent-(--color-accent-500)"
                  disabled={!settings}
                  checked={c[ch]}
                  onChange={(e) =>
                    save({ ...prefs, matrix: { ...prefs.matrix, [row.kind]: { ...c, [ch]: e.target.checked } } })
                  }
                />
              </span>
            ))}
          </div>
        );
      })}
    </SettingsCard>
    <SettingsCard>
      <SettingsRow
        id="settings-row-background-only"
        label="Only notify when Phasr is in the background"
        help="In-app badges always show"
      >
        <Switch
          label="Only notify when Phasr is in the background"
          checked={prefs.backgroundOnly}
          disabled={!settings}
          onChange={(v) => save({ ...prefs, backgroundOnly: v })}
        />
      </SettingsRow>
      <SettingsRow id="settings-row-quiet-hours" label="Quiet hours" help="Badges only, no sound or system alerts">
        <Switch
          label="Quiet hours"
          checked={prefs.quietHours.enabled}
          disabled={!settings}
          onChange={(v) => save({ ...prefs, quietHours: { ...prefs.quietHours, enabled: v } })}
        />
        <input
          type="time"
          aria-label="Quiet hours start"
          value={prefs.quietHours.start}
          disabled={!settings || !prefs.quietHours.enabled}
          onChange={(e) => save({ ...prefs, quietHours: { ...prefs.quietHours, start: e.target.value } })}
          className="h-7 w-[96px] px-2 py-0 text-[12px] tabular-nums disabled:opacity-40"
        />
        <span className="text-(--color-text-muted)">–</span>
        <input
          type="time"
          aria-label="Quiet hours end"
          value={prefs.quietHours.end}
          disabled={!settings || !prefs.quietHours.enabled}
          onChange={(e) => save({ ...prefs, quietHours: { ...prefs.quietHours, end: e.target.value } })}
          className="h-7 w-[96px] px-2 py-0 text-[12px] tabular-nums disabled:opacity-40"
        />
      </SettingsRow>
    </SettingsCard>
    <SettingsCard>
      <SettingsRow
        id="settings-row-system"
        label="System notifications"
        help={
          granted === false
            ? "Not allowed — turn on Phasr in System Settings › Notifications. In-app toasts still show."
            : "Shown when a task finishes or fails while Phasr is in the background."
        }
      >
        <span
          className={cn(
            "text-[12px]",
            granted ? "text-(--color-success)" : granted === false ? "text-(--color-warning)" : "text-(--color-text-muted)",
          )}
        >
          {granted === null ? "Checking…" : granted ? "Allowed" : "Not allowed"}
        </span>
      </SettingsRow>
      <AlertsStyleHint />
    </SettingsCard>
    </div>
  );
}
