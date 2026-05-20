import { useClerk, useUser } from "@clerk/react";
import { createFileRoute } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassPanel } from "@/components/ui/GlassPanel";
import { isClerkConfigured } from "@/lib/clerk";

function AccountPage() {
  if (!isClerkConfigured) {
    return <KeylessAccountPlaceholder />;
  }
  return <ClerkAccountPage />;
}

function KeylessAccountPlaceholder() {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight leading-none">Account</h2>
        <p className="mt-1.5 text-[12px] text-(--color-text-muted)">
          Cloud sync is not configured in this build.
        </p>
      </header>
      <GlassPanel className="p-5 text-[12.5px] leading-relaxed text-(--color-text-secondary)">
        <p>
          Phasr is running in local-only mode. Your repositories and workspaces live on this
          machine in SQLite. To enable sign-in and cross-device sync, add your own Clerk and
          Supabase keys to <code className="text-(--color-text-primary)">.env.local</code> and
          rebuild from source.
        </p>
        <p className="mt-2">
          See <code className="text-(--color-text-primary)">CONTRIBUTING.md</code> for setup.
        </p>
      </GlassPanel>
    </div>
  );
}

function ClerkAccountPage() {
  const { user } = useUser();
  const { signOut } = useClerk();

  if (!user) {
    return <div className="text-[12px] text-(--color-text-muted)">Loading account…</div>;
  }

  const email = user.primaryEmailAddress?.emailAddress ?? "";
  const initials = (user.firstName?.[0] ?? "") + (user.lastName?.[0] ?? "");

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight leading-none">Account</h2>
        <p className="mt-1.5 text-[12px] text-(--color-text-muted)">
          Profile data is managed by Clerk. Email can't be changed here.
        </p>
      </header>

      <GlassPanel className="p-5">
        <div className="flex items-center gap-4">
          {user.imageUrl ? (
            <img
              src={user.imageUrl}
              alt=""
              className="h-14 w-14 rounded-full border border-(--glass-border-hairline) object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-(--glass-border-hairline) bg-(--color-bg-hover) text-[13px] font-semibold uppercase">
              {initials || "?"}
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium leading-none">
              {user.fullName ?? "(no name set)"}
            </div>
            <div className="mt-1 truncate text-[12px] text-(--color-text-muted)">{email}</div>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel className="p-5">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
          Sessions
        </div>
        <p className="mt-2 text-[12px] text-(--color-text-secondary)">
          In-app session listing and "Sign out everywhere" land in a later settings pass. For now,
          signing out below ends this device's session.
        </p>
      </GlassPanel>

      <div>
        <GlassButton variant="danger" size="md" onClick={() => void signOut()}>
          <LogOut size={13} />
          Sign out
        </GlassButton>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_app/settings/account")({
  component: AccountPage,
});
