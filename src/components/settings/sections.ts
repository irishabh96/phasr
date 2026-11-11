/**
 * Settings registry — one entry per section of the sheet (A-Settings nav).
 * `rows` carries the searchable row labels so the sheet's search box and the
 * ⌘K palette can find a setting by what it is called, and deep-link to it.
 */
export const SETTINGS_SECTION_IDS = [
  "account",
  "appearance",
  "terminal",
  "agents",
  "voice",
  "run-commands",
  "keyboard",
  "notifications",
  "worktrees",
  "branch-rules",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsRowMeta {
  id: string;
  label: string;
  keywords?: string;
}

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  scope: "app" | "repo";
  rows: SettingsRowMeta[];
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "account",
    label: "Account",
    scope: "app",
    rows: [
      { id: "profile", label: "Profile", keywords: "name email avatar" },
      { id: "sign-out", label: "Sign out of this device" },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    scope: "app",
    rows: [
      { id: "theme", label: "Theme", keywords: "dark light system" },
      { id: "accent", label: "Accent", keywords: "color colour coral blue green violet amber" },
      { id: "density", label: "Interface density", keywords: "compact comfortable" },
      { id: "auto-collapse", label: "Fold side panels on narrow windows", keywords: "compact rail sidebar inspector" },
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    scope: "app",
    rows: [
      { id: "font", label: "Font", keywords: "monospace typeface" },
      { id: "font-size", label: "Font size", keywords: "zoom" },
      { id: "cursor", label: "Cursor", keywords: "block bar underline blink" },
      { id: "scrollback", label: "Scrollback", keywords: "history lines" },
      { id: "shell", label: "Shell", keywords: "zsh bash fish" },
      { id: "copy-on-select", label: "Copy on select", keywords: "clipboard" },
    ],
  },
  {
    id: "agents",
    label: "Agents & keys",
    scope: "app",
    rows: [
      { id: "agents", label: "Agents", keywords: "claude codex copilot gemini opencode command version detect" },
      { id: "permission-mode", label: "Default permission mode", keywords: "ask shell edits skip approvals" },
      { id: "suggest-replies", label: "Suggest replies", keywords: "suggestions chips composer haiku transcript next" },
      { id: "ANTHROPIC_API_KEY", label: "API keys", keywords: "anthropic openai gemini keychain token" },
    ],
  },
  {
    id: "voice",
    label: "Voice",
    scope: "app",
    rows: [
      { id: "voice-model", label: "Speech model", keywords: "whisper dictation dictate speech to text transcribe download microphone" },
      { id: "voice-cleanup", label: "Clean up the transcript", keywords: "polish fix haiku codex claude punctuation filler" },
      { id: "voice-language", label: "Spoken language", keywords: "whisper multilingual" },
      { id: "microphone", label: "Microphone access", keywords: "permission privacy" },
    ],
  },
  {
    id: "run-commands",
    label: "Run commands",
    scope: "repo",
    rows: [{ id: "commands", label: "Run commands", keywords: "dev test pinned script checks before review task start port" }],
  },
  {
    id: "keyboard",
    label: "Keyboard",
    scope: "app",
    rows: [{ id: "shortcuts", label: "Shortcuts", keywords: "keys bindings hotkeys" }],
  },
  {
    id: "notifications",
    label: "Notifications",
    scope: "app",
    rows: [
      { id: "matrix", label: "Notification events", keywords: "approval finished failed checks badge sound" },
      { id: "background-only", label: "Only notify in the background", keywords: "focus" },
      { id: "quiet-hours", label: "Quiet hours", keywords: "do not disturb night" },
      { id: "system", label: "System notifications", keywords: "alerts permission" },
    ],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    scope: "repo",
    rows: [
      { id: "location", label: "Location", keywords: "path folder" },
      { id: "after-create", label: "After creating", keywords: "hook install setup" },
      { id: "copy-untracked", label: "Copy untracked files", keywords: "env dotenv" },
      { id: "cleanup", label: "Clean up after merge", keywords: "remove delete" },
    ],
  },
  {
    id: "branch-rules",
    label: "Branch rules",
    scope: "repo",
    rows: [
      { id: "default-base", label: "Default base branch", keywords: "main" },
      { id: "branch-pattern", label: "Branch name pattern", keywords: "prefix" },
      { id: "fetch-base", label: "Fetch base before every task", keywords: "pull origin" },
      { id: "agents-push", label: "Agents may push", keywords: "git push remote" },
      { id: "pr-mode", label: "Open PRs as", keywords: "draft ready pull request" },
      { id: "protected-paths", label: "Protected paths", keywords: "ask edit glob" },
    ],
  },
];

export function sectionMeta(id: SettingsSectionId): SettingsSectionMeta {
  return SETTINGS_SECTIONS.find((s) => s.id === id)!;
}

/** Sections (and the matching rows) whose label/keywords contain `query`. */
export function searchSettings(query: string): { section: SettingsSectionMeta; rows: SettingsRowMeta[] }[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_SECTIONS.map((section) => ({ section, rows: [] }));
  const hits: { section: SettingsSectionMeta; rows: SettingsRowMeta[] }[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const rows = section.rows.filter((r) => `${r.label} ${r.keywords ?? ""}`.toLowerCase().includes(q));
    if (rows.length > 0 || section.label.toLowerCase().includes(q)) hits.push({ section, rows });
  }
  return hits;
}
