import { createFileRoute } from "@tanstack/react-router";
import { useUiStore } from "@/lib/store";
import type { Theme } from "@/lib/theme";

const THEMES: Theme[] = ["dark", "light", "system"];

function Index() {
  const { theme, setTheme } = useUiStore();

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Phasr</h1>
      <p className="mt-2 text-sm text-(--color-text-secondary)">
        Run multiple coding agents in parallel, each in an isolated git worktree.
      </p>

      <section className="mt-10 rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
        <h2 className="text-sm font-medium text-(--color-text-secondary)">
          Scaffolding sanity check
        </h2>
        <p className="mt-2 text-xs text-(--color-text-muted)">
          Tauri 2 · React 19 · Vite · Tailwind v4 · TanStack Router · TanStack Query · Zustand
        </p>

        <div className="mt-6 flex items-center gap-3">
          <span className="text-sm text-(--color-text-secondary)">Theme:</span>
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTheme(option)}
              data-active={theme === option}
              className="rounded-md border border-(--color-border-default) bg-(--color-bg-input) px-3 py-1.5 text-sm text-(--color-text-primary) transition-colors hover:border-(--color-border-strong) data-[active=true]:border-(--color-accent-500) data-[active=true]:bg-(--color-accent-600) data-[active=true]:text-white"
            >
              {option}
            </button>
          ))}
        </div>

        <div className="mt-6 flex items-center gap-2 text-xs">
          <span className="rounded-full bg-(--color-success)/15 px-2 py-0.5 text-(--color-success)">
            ● success
          </span>
          <span className="rounded-full bg-(--color-warning)/15 px-2 py-0.5 text-(--color-warning)">
            ● warning
          </span>
          <span className="rounded-full bg-(--color-danger)/15 px-2 py-0.5 text-(--color-danger)">
            ● danger
          </span>
          <span className="rounded-full bg-(--color-info)/15 px-2 py-0.5 text-(--color-info)">
            ● info
          </span>
        </div>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/")({
  component: Index,
});
