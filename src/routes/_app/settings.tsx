import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { ArrowLeft, Bot, Palette, UserCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  { label: "Account", to: "/settings/account", icon: <UserCircle size={13} /> },
  { label: "Appearance", to: "/settings/appearance", icon: <Palette size={13} /> },
  { label: "Agents", to: "/settings/agents", icon: <Bot size={13} /> },
];

function SettingsLayout() {
  const location = useLocation();
  const active = location.pathname;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl gap-8 px-8 py-10">
      <aside className="w-44 shrink-0">
        <Link
          to="/"
          className="mb-5 inline-flex items-center gap-1.5 text-[11px] text-(--color-text-muted) transition-colors hover:text-(--color-text-primary)"
        >
          <ArrowLeft size={11} />
          Back
        </Link>
        <h1 className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
          Settings
        </h1>
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const isActive = active === item.to || active.startsWith(`${item.to}/`);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={cn(
                    "flex h-[38px] items-center gap-2 rounded-[10px] px-3 text-[14px] font-medium leading-none",
                    "transition-colors duration-150",
                    isActive
                      ? "bg-[color-mix(in_oklab,var(--color-accent-500)_12%,transparent)] text-(--color-text-primary)"
                      : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});
