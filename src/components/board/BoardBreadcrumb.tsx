import { Link } from "@tanstack/react-router";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { cn } from "@/lib/utils";

/**
 * The task board's back-nav breadcrumb: `{repo} / {epic goal}`. The repo crumb
 * links back to the repository home; the epic goal is the current page
 * (`aria-current`). All meaning rides text — no glyph-only signal. 40px header
 * row, 13px crumbs, the epic goal truncates at 40ch (spec).
 */
export function BoardBreadcrumb({
  repositoryId,
  goal,
}: {
  repositoryId: string;
  goal: string;
}) {
  const { data: repos } = useRepositories();
  const repoName =
    repos?.find((r) => r.id === repositoryId)?.name ?? "Repository";

  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="board-breadcrumb"
      className="flex h-10 shrink-0 items-center gap-1.5 text-[13px]"
    >
      <Link
        to="/repositories/$repositoryId"
        params={{ repositoryId }}
        data-testid="board-breadcrumb-repo"
        className={cn(
          "-mx-1 rounded-[6px] px-1 py-0.5 text-(--color-text-muted)",
          "transition-colors duration-150 hover:text-(--color-text-primary)",
          "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
        )}
      >
        {repoName}
      </Link>
      <span aria-hidden="true" className="text-(--color-text-muted)">
        /
      </span>
      <span
        aria-current="page"
        title={goal}
        className="max-w-[40ch] truncate font-medium text-(--color-text-primary)"
      >
        {goal}
      </span>
    </nav>
  );
}
