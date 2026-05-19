import { useClerk, useUser } from "@clerk/react";
import { createFileRoute } from "@tanstack/react-router";
import { LogOut } from "lucide-react";

function AccountPage() {
  const { user } = useUser();
  const { signOut } = useClerk();

  if (!user) {
    return (
      <div className="text-sm text-(--color-text-muted)">Loading account…</div>
    );
  }

  const email = user.primaryEmailAddress?.emailAddress ?? "";
  const initials = (user.firstName?.[0] ?? "") + (user.lastName?.[0] ?? "");

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-base font-semibold tracking-tight">Account</h2>
        <p className="mt-1 text-xs text-(--color-text-muted)">
          Profile data is managed by Clerk. Email can't be changed here.
        </p>
      </header>

      <section className="flex items-center gap-4">
        {user.imageUrl ? (
          <img
            src={user.imageUrl}
            alt=""
            className="h-14 w-14 rounded-full border border-(--color-border-default) object-cover"
          />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-(--color-border-default) bg-(--color-bg-elevated) text-sm font-medium uppercase">
            {initials || "?"}
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {user.fullName ?? "(no name set)"}
          </div>
          <div className="truncate text-xs text-(--color-text-muted)">{email}</div>
        </div>
      </section>

      <section className="space-y-2 border-t border-(--color-border-subtle) pt-6">
        <div className="text-xs font-medium uppercase tracking-wide text-(--color-text-muted)">
          Sessions
        </div>
        <p className="text-xs text-(--color-text-secondary)">
          In-app session listing and "Sign out everywhere" land in a later
          settings pass. For now, signing out below ends this device's
          session.
        </p>
      </section>

      <section className="border-t border-(--color-border-subtle) pt-6">
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex items-center gap-2 rounded-md border border-(--color-danger) bg-(--color-danger)/10 px-3 py-1.5 text-sm text-(--color-danger) hover:bg-(--color-danger)/20"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/account")({
  component: AccountPage,
});
