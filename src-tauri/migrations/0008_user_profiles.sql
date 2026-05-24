-- Store the authenticated Clerk profile once and let local metadata rows
-- point at that user record. `users.id` intentionally remains the Clerk
-- `sub` so existing Supabase RLS semantics and already-synced rows keep
-- working while the schema gains a real FK target.

CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    clerk_user_id  TEXT NOT NULL UNIQUE,
    name           TEXT,
    email          TEXT,
    image_url      TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    synced_at      TEXT,
    dirty          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_users_dirty ON users(dirty) WHERE dirty = 1;
CREATE INDEX idx_users_email ON users(email);

ALTER TABLE repositories      ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE workspaces        ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE repository_config ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE run_commands      ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE user_settings     ADD COLUMN user_id TEXT REFERENCES users(id);

CREATE INDEX idx_repositories_user ON repositories(user_id);
CREATE INDEX idx_workspaces_user ON workspaces(user_id);
CREATE INDEX idx_run_commands_user ON run_commands(user_id);
