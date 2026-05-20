-- Phasr cloud schema. Run this once against your Supabase project, either
-- via `supabase db push` (CLI) or by pasting into the SQL editor.
--
-- Architecture: local SQLite is the source of truth on each machine. The
-- React-side sync layer mirrors workspace/task/setting metadata up to
-- Supabase so the same Clerk account on another machine sees the same
-- data. Logs and worktrees stay local.
--
-- Row-level security is keyed on the signed-in Clerk user. The Clerk
-- Third-Party Auth integration must be configured for your project
-- (Authentication → Providers → Clerk in the Supabase dashboard). Once
-- it is, `auth.jwt() ->> 'sub'` resolves to the Clerk user id for
-- requests made with a Clerk JWT.

------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------

create table if not exists public.workspaces (
    id              uuid primary key,
    user_id         text not null,
    name            text not null,
    remote_url      text,
    -- Per-machine local clone paths. JSON keyed by an opaque
    -- machine_id stored in the OS keychain (see the React sync layer).
    local_paths     jsonb not null default '{}'::jsonb,
    default_branch  text not null default 'main',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists public.presets (
    id              uuid primary key,
    user_id         text not null,
    name            text not null,
    command         text not null,
    icon            text,
    is_default      boolean not null default false,
    is_enabled      boolean not null default true,
    is_seed         boolean not null default false,
    sort_order      integer not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists public.tasks (
    id              uuid primary key,
    user_id         text not null,
    workspace_id    uuid not null references public.workspaces(id) on delete cascade,
    name            text not null,
    prompt          text,
    preset_id       uuid references public.presets(id) on delete set null,
    command         text not null,
    status          text not null,
    branch          text,
    worktree_path   text,
    exit_code       integer,
    created_at      timestamptz not null default now(),
    started_at      timestamptz,
    finished_at     timestamptz,
    archived_at     timestamptz,
    updated_at      timestamptz not null default now()
);

create table if not exists public.workspace_config (
    workspace_id            uuid primary key references public.workspaces(id) on delete cascade,
    user_id                 text not null,
    branch_prefix_template  text,
    worktree_base_path      text,
    default_merge_strategy  text,
    env_vars                jsonb not null default '{}'::jsonb,
    pre_task_hook           text,
    post_task_hook          text,
    updated_at              timestamptz not null default now()
);

create table if not exists public.run_commands (
    id              uuid primary key,
    user_id         text not null,
    workspace_id    uuid not null references public.workspaces(id) on delete cascade,
    name            text not null,
    command         text not null,
    shortcut        text,
    pinned          boolean not null default false,
    sort_order      integer not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists public.user_settings (
    user_id                 text primary key,
    theme                   text not null default 'dark',
    accent_color            text not null default 'indigo',
    sans_font               text not null default 'Inter',
    mono_font               text not null default 'JetBrains Mono',
    base_font_size          integer not null default 13,
    cursor_style            text not null default 'block',
    cursor_blink            boolean not null default true,
    terminal_scrollback     integer not null default 10000,
    default_editor          text not null default 'vscode',
    default_terminal        text not null default 'iterm',
    default_preset_id       uuid references public.presets(id) on delete set null,
    keyboard_shortcuts      jsonb not null default '{}'::jsonb,
    branch_prefix_template  text not null default 'phasr/{{slug}}',
    worktree_base_path      text not null default '~/.phasr/worktrees',
    default_merge_strategy  text not null default 'merge',
    auto_fetch_seconds      integer not null default 60,
    honor_gpg_sign          boolean not null default true,
    auto_push_on_commit     boolean not null default false,
    updated_at              timestamptz not null default now()
);

------------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------------

create index if not exists idx_workspaces_user_updated
    on public.workspaces (user_id, updated_at desc);

create index if not exists idx_tasks_user_workspace
    on public.tasks (user_id, workspace_id, created_at desc);

create index if not exists idx_tasks_user_status
    on public.tasks (user_id, status);

create index if not exists idx_presets_user
    on public.presets (user_id, sort_order);

create index if not exists idx_run_commands_user_workspace
    on public.run_commands (user_id, workspace_id, sort_order);

------------------------------------------------------------------------
-- Row-level security
------------------------------------------------------------------------

alter table public.workspaces       enable row level security;
alter table public.tasks            enable row level security;
alter table public.presets          enable row level security;
alter table public.workspace_config enable row level security;
alter table public.run_commands     enable row level security;
alter table public.user_settings    enable row level security;

-- A helper that returns the Clerk user id from the JWT. Wrapped in a
-- function so policies stay readable.
create or replace function public.clerk_user_id()
returns text language sql stable as $$
    select coalesce(auth.jwt() ->> 'sub', '')
$$;

-- Symmetric policies: a user can SELECT/INSERT/UPDATE/DELETE their own
-- rows. We avoid a single FOR ALL policy so we can express "INSERT
-- requires the new row to match the user" via WITH CHECK.

create policy workspaces_select on public.workspaces
    for select using (user_id = public.clerk_user_id());
create policy workspaces_insert on public.workspaces
    for insert with check (user_id = public.clerk_user_id());
create policy workspaces_update on public.workspaces
    for update using (user_id = public.clerk_user_id())
                  with check (user_id = public.clerk_user_id());
create policy workspaces_delete on public.workspaces
    for delete using (user_id = public.clerk_user_id());

create policy tasks_select on public.tasks
    for select using (user_id = public.clerk_user_id());
create policy tasks_insert on public.tasks
    for insert with check (user_id = public.clerk_user_id());
create policy tasks_update on public.tasks
    for update using (user_id = public.clerk_user_id())
                  with check (user_id = public.clerk_user_id());
create policy tasks_delete on public.tasks
    for delete using (user_id = public.clerk_user_id());

create policy presets_select on public.presets
    for select using (user_id = public.clerk_user_id());
create policy presets_insert on public.presets
    for insert with check (user_id = public.clerk_user_id());
create policy presets_update on public.presets
    for update using (user_id = public.clerk_user_id())
                  with check (user_id = public.clerk_user_id());
create policy presets_delete on public.presets
    for delete using (user_id = public.clerk_user_id());

create policy workspace_config_select on public.workspace_config
    for select using (user_id = public.clerk_user_id());
create policy workspace_config_insert on public.workspace_config
    for insert with check (user_id = public.clerk_user_id());
create policy workspace_config_update on public.workspace_config
    for update using (user_id = public.clerk_user_id())
                  with check (user_id = public.clerk_user_id());
create policy workspace_config_delete on public.workspace_config
    for delete using (user_id = public.clerk_user_id());

create policy run_commands_select on public.run_commands
    for select using (user_id = public.clerk_user_id());
create policy run_commands_insert on public.run_commands
    for insert with check (user_id = public.clerk_user_id());
create policy run_commands_update on public.run_commands
    for update using (user_id = public.clerk_user_id())
                  with check (user_id = public.clerk_user_id());
create policy run_commands_delete on public.run_commands
    for delete using (user_id = public.clerk_user_id());

create policy user_settings_select on public.user_settings
    for select using (user_id = public.clerk_user_id());
create policy user_settings_insert on public.user_settings
    for insert with check (user_id = public.clerk_user_id());
create policy user_settings_update on public.user_settings
    for update using (user_id = public.clerk_user_id())
                  with check (user_id = public.clerk_user_id());

------------------------------------------------------------------------
-- Realtime
------------------------------------------------------------------------
-- Phasr's sync layer subscribes to row changes so a second device
-- picks up edits without polling.

alter publication supabase_realtime add table public.workspaces;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.presets;
alter publication supabase_realtime add table public.workspace_config;
alter publication supabase_realtime add table public.run_commands;
alter publication supabase_realtime add table public.user_settings;
