import { createFileRoute } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassPanel } from "@/components/ui/GlassPanel";
import {
  type DesktopSession,
  readDesktopSession,
  signOutDesktopSession,
} from "@/lib/desktopAuth";

function AccountPage() {
  return <ClerkAccountPage />;
}

function accountDisplayName(session: DesktopSession) {
  return session.profile.name ?? session.profile.email ?? "Signed in";
}

function accountSubtitle(session: DesktopSession) {
  return session.profile.email ?? "Profile email not provided by Clerk.";
}

function accountInitials(session: DesktopSession) {
  const label = session.profile.name ?? session.profile.email ?? "Phasr";
  const parts = label
    .replace(/@.*/, "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }

  return (parts[0]?.slice(0, 2) || "P").toUpperCase();
}

function ClerkAccountPage() {
  const session = readDesktopSession();

  if (!session) {
    return <div className="text-[12px] text-(--color-text-muted)">Loading account…</div>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight leading-none">Account</h2>
        <p className="mt-1.5 text-[12px] text-(--color-text-muted)">
          This device is signed in with a verified Clerk desktop session.
        </p>
      </header>

      <GlassPanel className="p-5">
        <div className="flex items-center gap-4">
          {session.profile.imageUrl ? (
            <img
              src={session.profile.imageUrl}
              alt=""
              className="h-14 w-14 rounded-full border border-(--glass-border-hairline) bg-(--color-bg-hover) object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-(--glass-border-hairline) bg-(--color-bg-hover) text-[13px] font-semibold uppercase">
              {accountInitials(session)}
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium leading-none">
              {accountDisplayName(session)}
            </div>
            <div className="mt-1 truncate text-[12px] text-(--color-text-muted)">
              {accountSubtitle(session)}
            </div>
          </div>
        </div>
      </GlassPanel>

      <div>
        <GlassButton
          variant="danger"
          size="md"
          onClick={() => {
            void signOutDesktopSession().then(() => {
              window.location.href = "/sign-in";
            });
          }}
        >
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
