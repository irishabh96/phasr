-- Store the signed-in Clerk profile in Supabase. The primary key stays
-- equal to the Clerk `sub` claim so existing `user_id` columns can point at
-- this table without changing the current RLS model.

CREATE TABLE IF NOT EXISTS public.users (
    id             text PRIMARY KEY,
    clerk_user_id  text NOT NULL UNIQUE,
    name           text NOT NULL,
    email          text NOT NULL,
    image_url      text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email
    ON public.users (email);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'users'
          AND policyname = 'users_select'
    ) THEN
        CREATE POLICY users_select ON public.users
            FOR SELECT USING (id = public.clerk_user_id());
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'users'
          AND policyname = 'users_insert'
    ) THEN
        CREATE POLICY users_insert ON public.users
            FOR INSERT WITH CHECK (id = public.clerk_user_id());
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'users'
          AND policyname = 'users_update'
    ) THEN
        CREATE POLICY users_update ON public.users
            FOR UPDATE USING (id = public.clerk_user_id())
                      WITH CHECK (id = public.clerk_user_id());
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repositories_user_id_fkey'
          AND conrelid = 'public.repositories'::regclass
    ) THEN
        ALTER TABLE public.repositories
            ADD CONSTRAINT repositories_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspaces_user_id_fkey'
          AND conrelid = 'public.workspaces'::regclass
    ) THEN
        ALTER TABLE public.workspaces
            ADD CONSTRAINT workspaces_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'repository_config_user_id_fkey'
          AND conrelid = 'public.repository_config'::regclass
    ) THEN
        ALTER TABLE public.repository_config
            ADD CONSTRAINT repository_config_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'run_commands_user_id_fkey'
          AND conrelid = 'public.run_commands'::regclass
    ) THEN
        ALTER TABLE public.run_commands
            ADD CONSTRAINT run_commands_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_settings_user_id_fkey'
          AND conrelid = 'public.user_settings'::regclass
    ) THEN
        ALTER TABLE public.user_settings
            ADD CONSTRAINT user_settings_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'users'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
    END IF;
END $$;
