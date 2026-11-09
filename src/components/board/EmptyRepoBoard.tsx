import { BOARD_COLUMNS } from "@/lib/board";
import { NewTaskButton } from "./NewTaskButton";

/**
 * A-EmptyRepo under the Polish rules: the four columns as quiet tone blocks
 * (no dashed outlines) behind a first-task card. Sentence-case label, no
 * uppercase, and the one primary action keeps ⌘N in its tooltip.
 */
export function EmptyRepoBoard({ repoName, onNewTask }: { repoName: string | null; onNewTask: (() => void) | null }) {
  return (
    <div className="relative h-full min-h-[520px]">
      <div aria-hidden className="grid h-full grid-cols-4 gap-[12px] px-[24px] pt-[8px] pb-[24px]">
        {BOARD_COLUMNS.map((c) => (
          <div key={c.id} className="flex min-h-0 flex-col gap-[8px]">
            <span className="flex h-[28px] items-center gap-[8px] px-[4px] text-[12.5px] text-(--color-text-faint)">
              <span className="size-[6px] rounded-full bg-(--color-bg-hover)" />
              {c.title}
            </span>
            <span className="flex-1 rounded-(--radius-card) bg-(--color-bg-input) opacity-60" />
          </div>
        ))}
      </div>
      <div className="absolute inset-0 grid place-items-center p-[24px]">
        {/* One flat column (4px rhythm, 14px before the action) so the heading,
            copy and its call to action share a parent. */}
        <div className="flex w-full max-w-[620px] -translate-y-[2%] flex-col gap-[4px] glass-modal p-[22px]">
          <span className="text-[12px] text-(--color-text-muted)">
            {repoName ? `${repoName} is ready` : "Ready when you are"}
          </span>
          <h2 className="m-0 text-[18px] font-semibold leading-tight">Give an agent its first task</h2>
          <p className="m-0 text-[12.5px] leading-[1.5] text-(--color-text-secondary)">
            It runs on its own branch in a worktree, so your checkout stays untouched. You review the diff before
            anything merges.
          </p>
          <div className="mt-[10px]">
            <NewTaskButton onNewTask={onNewTask} />
          </div>
        </div>
      </div>
    </div>
  );
}
