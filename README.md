# Phasr

Run multiple coding agents in parallel, each in an isolated git worktree.

Phasr is a desktop application (Tauri 2 + React 19) that orchestrates concurrent
coding-agent tasks — Claude, Codex, Cursor, Copilot, Gemini, and others — with
per-task git worktrees, live PTY streaming, and an integrated git workflow.

## Status

This branch (`rebuild`) is a ground-up rewrite. The previous Go/webview_go
implementation lives in `master`'s history. See the rebuild plan at
`~/.claude/plans/i-want-to-rebuild-enchanted-gosling.md`.

## Stack

- **Desktop shell**: Tauri 2 (Rust)
- **Frontend**: React 19 + Vite + Tailwind v4
- **Router**: TanStack Router (file-based)
- **Data**: TanStack Query + Zustand
- **Auth** (Phase 2): Clerk
- **Local DB** (Phase 3): SQLite via `tauri-plugin-sql`
- **Cloud DB** (Phase 6): Supabase (Postgres + Realtime)

## Develop

```sh
pnpm install         # one-time
pnpm dev             # vite dev server only (web UI in browser)
pnpm tauri dev       # full desktop app with Rust backend
pnpm build           # production web bundle
pnpm tauri build     # production desktop binary
pnpm typecheck       # tsc -b --noEmit
pnpm test            # vitest run
```

## Layout

```
phasr/
├─ src/                    React app
│  ├─ routes/             TanStack Router file routes
│  ├─ lib/                utils, theme, query, store
│  ├─ main.tsx
│  └─ index.css           Tailwind v4 + design tokens
├─ src-tauri/             Rust backend
│  ├─ src/
│  ├─ Cargo.toml
│  └─ tauri.conf.json
└─ package.json
```
