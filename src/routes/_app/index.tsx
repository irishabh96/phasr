import { useUser } from "@clerk/react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AddWorkspaceForm } from "@/components/AddWorkspaceForm";
import { useDeleteWorkspace, useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { usePresets } from "@/lib/hooks/usePresets";

function Home() {
  const { user } = useUser();
  const { data: workspaces, isLoading } = useWorkspaces();
  const deleteWorkspace = useDeleteWorkspace();
  const { data: presets } = usePresets();

  return (
    <div className="mx-auto max-w-4xl px-8 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome
        {user?.firstName ? `, ${user.firstName}` : ""}
      </h1>
      <p className="mt-2 text-sm text-(--color-text-secondary)">
        Phase 3 sanity check: workspaces and presets persist in local SQLite.
      </p>

      <section className="mt-10 rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
        <h2 className="text-sm font-medium">Workspaces ({workspaces?.length ?? 0})</h2>
        <p className="mt-1 text-xs text-(--color-text-muted)">
          Stored in SQLite. Restart the app — they'll still be here.
        </p>

        <div className="mt-4">
          <AddWorkspaceForm />
        </div>

        <ul className="mt-6 divide-y divide-(--color-border-subtle)">
          {isLoading && <li className="py-3 text-xs text-(--color-text-muted)">Loading…</li>}
          {!isLoading && workspaces?.length === 0 && (
            <li className="py-3 text-xs text-(--color-text-muted)">
              No workspaces yet — add one above.
            </li>
          )}
          {workspaces?.map((ws) => (
            <li key={ws.id} className="flex items-center justify-between py-3">
              <Link
                to="/workspaces/$workspaceId"
                params={{ workspaceId: ws.id }}
                className="min-w-0 flex-1 hover:text-(--color-accent-400)"
              >
                <div className="truncate text-sm">{ws.name}</div>
                <div className="truncate text-xs text-(--color-text-muted)">
                  {ws.localPath ?? "(no local path)"}
                </div>
              </Link>
              <button
                type="button"
                onClick={() => deleteWorkspace.mutate(ws.id)}
                disabled={deleteWorkspace.isPending}
                className="rounded-md border border-(--color-border-default) px-2 py-1 text-xs text-(--color-text-secondary) hover:border-(--color-danger) hover:text-(--color-danger)"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
        <h2 className="text-sm font-medium">
          Seeded agent presets ({presets?.length ?? 0})
        </h2>
        <p className="mt-1 text-xs text-(--color-text-muted)">
          Auto-inserted on first DB init. Edit/toggle in Settings (Phase 7).
        </p>
        <ul className="mt-4 space-y-1 text-xs">
          {presets?.map((p) => (
            <li key={p.id} className="flex items-center gap-3">
              <span className="min-w-[110px] font-medium">{p.name}</span>
              <code className="truncate text-(--color-text-muted)">{p.command}</code>
              {p.isDefault && (
                <span className="ml-auto rounded bg-(--color-accent-600)/15 px-1.5 text-[10px] text-(--color-accent-400)">
                  default
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/_app/")({
  component: Home,
});
