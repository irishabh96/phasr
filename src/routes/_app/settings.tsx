import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { ArrowLeft, Bot, Palette, UserCircle } from "lucide-react";

interface NavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  { label: "Account", to: "/settings/account", icon: <UserCircle size={14} /> },
  { label: "Appearance", to: "/settings/appearance", icon: <Palette size={14} /> },
  { label: "Agents", to: "/settings/agents", icon: <Bot size={14} /> },
];

function SettingsLayout() {
  const location = useLocation();
  const active = location.pathname;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl gap-6 px-8 py-10">
      <aside className="w-44 shrink-0">
        <Link
          to="/"
          className="mb-4 flex items-center gap-1.5 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary)"
        >
          <ArrowLeft size={12} />
          Back to repositories
        </Link>
        <h1 className="mb-4 text-xs font-medium uppercase tracking-wide text-(--color-text-muted)">
          Settings
        </h1>
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const isActive = active === item.to || active.startsWith(`${item.to}/`);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"
                  data-active={isActive}
                  style={{
                    background: isActive ? "var(--color-bg-elevated)" : "transparent",
                    color: isActive ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                  }}
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
