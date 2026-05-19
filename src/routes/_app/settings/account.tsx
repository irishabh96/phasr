import { useClerk, useUser } from "@clerk/react";
import { createFileRoute } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassPanel } from "@/components/ui/GlassPanel";

function AccountPage() {
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
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-(--glass-border-hairline) bg-[color-mix(in_oklab,white_6%,transparent)] text-[13px] font-semibold uppercase">
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
