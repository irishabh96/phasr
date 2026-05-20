# Phasr

**Run multiple coding agents in parallel, each in its own isolated git worktree.**

Phasr is a desktop app that orchestrates concurrent coding-agent sessions
— Claude, Codex, Copilot, Gemini, OpenCode — with per-workspace git
worktrees, live terminal streaming, and an integrated git workflow.

> Pre-1.0, macOS only. Builds are unsigned for now (see Install below).

## Install (macOS)

1. Grab the latest DMG for your Mac from [Releases](https://github.com/irishabh96/phasr/releases):
   - **Apple Silicon** (M1, M2, M3, M4) → `Phasr_<version>_aarch64.dmg`
   - **Intel** → `Phasr_<version>_x64.dmg`

   Not sure? Apple menu → *About This Mac*. If "Chip" starts with "Apple", grab the aarch64 build. If it says "Intel", grab x64.

2. Open the DMG and drag **Phasr** to your **Applications** folder.

3. **First launch — Gatekeeper bypass (one-time).** Phasr is not yet code-signed, so macOS will refuse to open it by double-click. Either:
   - Right-click *Phasr.app* in Applications → **Open** → **Open** in the dialog. Subsequent launches work normally.
   - Or, from Terminal:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Phasr.app
     ```

   We're working on a signed build for a future release.

## What you'll need

- One or more agent CLIs on your `PATH`. Phasr launches whichever one you choose per workspace.
  - `claude` (Anthropic's Claude Code)
  - `codex` (OpenAI Codex CLI)
  - `copilot` (GitHub Copilot CLI)
  - `gemini` (Google Gemini CLI)
  - `opencode`
- `git`.

You can add or edit agents from **Settings → Agents** inside the app.

## Develop / contribute

Quick start:

```sh
git clone https://github.com/irishabh96/phasr
cd phasr
pnpm install
pnpm tauri dev
```

That's enough to run a fully local build — no cloud credentials required. Sign-in and cross-device sync are skipped, your data lives in SQLite at `~/Library/Application Support/sh.phasr.desktop`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup, common commands, and PR flow.

## Stack

- **Desktop shell**: Tauri 2 (Rust)
- **Frontend**: React 19 + Vite + Tailwind v4
- **Router / data**: TanStack Router + Query, Zustand
- **Local DB**: SQLite via `sqlx`
- **Terminals**: xterm.js + WebGL renderer, backed by a per-workspace PTY in Rust
- *(Optional)* Cloud sync via Clerk + Supabase — disabled in keyless builds

## Releases

Releases are cut by tagging `v*` on `master`. GitHub Actions builds both arch DMGs and uploads them as a draft release. See [RELEASING.md](RELEASING.md) for the maintainer flow.

## License

[MIT](LICENSE).
