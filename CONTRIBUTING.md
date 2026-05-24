# Contributing to Phasr

Thanks for contributing.

## Ground rules

- Be respectful — follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- Keep changes focused and reviewable.
- Don't commit secrets, tokens, certs, or private keys. The repo is intentionally key-free; if you need cloud features locally, use your **own** Clerk + Supabase projects (see below).
- Don't ask for the maintainer's production keys.

## Prerequisites

- **Node 20+** and **pnpm 8+** (`corepack enable && corepack prepare pnpm@8 --activate` if you don't have it)
- **Rust stable** (`rustup toolchain install stable`)
- **Xcode Command Line Tools** (`xcode-select --install`)

## Quick start

```sh
git clone https://github.com/irishabh96/phasr
cd phasr
pnpm install
pnpm tauri dev
```

This boots the full desktop app — Rust backend + React UI — in development mode. **No `.env.local` is required.** Without cloud credentials, Phasr runs local-only: workspaces live in SQLite, no sign-in screen, no cross-device sync.

## Optional: enable cloud sync locally

If you want to exercise the Clerk-auth and Supabase-sync paths during development, create your own Clerk + Supabase projects (free tiers are fine), then:

```sh
cp .env.example .env.local
# Fill in your own keys (NOT the maintainer's):
#   VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
#   VITE_SUPABASE_URL=https://<project>.supabase.co
#   VITE_SUPABASE_ANON_KEY=eyJ...
#   VITE_SENTRY_DSN=https://...@sentry.io/... # optional
#   VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=0.1 # optional
#   VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=1.0 # optional
```

The Supabase project needs the Phasr schema installed (`supabase/migrations/`) and Clerk JWT integration configured.

`.env.local` is gitignored — it won't be committed by accident.

## Common commands

```sh
# Frontend
pnpm dev             # Vite dev server only (web UI in a browser; no Tauri)
pnpm tauri dev       # Full desktop app (Rust + React)
pnpm typecheck       # tsc -b --noEmit
pnpm build           # Production web bundle
pnpm tauri build     # Production desktop binary (per current Mac arch)

# Backend (Rust, from repo root)
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## Code layout

```
phasr/
├─ src/                              React app
│  ├─ routes/                        TanStack Router file routes
│  │  └─ _app/                       Auth-gated layout + nested routes
│  ├─ components/                    UI components
│  ├─ lib/                           Hooks, store, helpers
│  └─ index.css                      Tailwind v4 + design tokens
├─ src-tauri/                        Rust backend
│  ├─ src/
│  │  ├─ commands/                   Tauri command handlers
│  │  ├─ domain/                     Pure types
│  │  ├─ store/                      SQLite repositories
│  │  ├─ pty/                        PTY runtime
│  │  └─ git/                        Worktree + diff helpers
│  ├─ migrations/                    SQLx SQLite migrations
│  ├─ icons/                         App icon set
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ supabase/                         Cloud schema (optional)
└─ package.json
```

## Branching & PRs

1. Branch from `master`.
2. Implement the change.
3. Run checks locally:
   - `pnpm typecheck`
   - `pnpm build`
   - `cargo test --manifest-path src-tauri/Cargo.toml`
4. Open a PR. CI runs the same checks on Linux. A green CI is required before merge.
5. PR description: what changed, why, how it was tested.

## Commit conventions

- Imperative mood ("Add foo", not "Added foo").
- Keep unrelated refactors out of feature/fix commits.
- Reference issues when applicable.

## Releases

We tag releases with `v<semver>` and let GitHub Actions build the Mac DMGs. See [RELEASING.md](RELEASING.md) for the procedure (maintainer-only).

## Security

Don't open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for private reporting.
