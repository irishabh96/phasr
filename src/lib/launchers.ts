/**
 * Friendly labels for launcher ids. The Rust side stores launchers
 * keyed by short ids ("vscode", "iterm", etc.) and these get echoed
 * straight into `user_settings.defaultEditor` / `defaultTerminal`. The
 * UI uses these labels for buttons like "Open in VS Code".
 *
 * Unknown ids fall back to "App" via `labelForLauncher`.
 */
export const LAUNCHER_LABELS: Record<string, string> = {
  // Editors
  vscode: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
  windsurf: "Windsurf",
  antigravity: "Antigravity",
  xcode: "Xcode",
  intellij: "IntelliJ",
  webstorm: "WebStorm",
  pycharm: "PyCharm",
  goland: "GoLand",
  rustrover: "RustRover",
  clion: "CLion",
  phpstorm: "PhpStorm",
  rubymine: "RubyMine",
  datagrip: "DataGrip",
  rider: "Rider",
  fleet: "Fleet",
  // Terminals
  iterm: "iTerm",
  warp: "Warp",
  terminal: "Terminal",
  ghostty: "Ghostty",
  // File manager
  finder: "Finder",
};

export function labelForLauncher(id: string | null | undefined): string {
  if (!id) return "App";
  return LAUNCHER_LABELS[id] ?? "App";
}
