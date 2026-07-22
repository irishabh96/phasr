import { formatDuration } from "@/lib/formatDuration";
import type { TicketComment } from "@/lib/types";
import { cn } from "@/lib/utils";

/** First letter of a name, uppercased — the avatar glyph (mockup Page 04). */
function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/**
 * The comment thread (mockup Page 04) — human vs agent entries styled
 * distinctly: a human's avatar is neutral-strong, an agent's is muted and its
 * meta shows a persona/role chip. Meaning rides text (`· you` / `· agent`), not
 * color. Pure & prop-driven so `/design-test` renders it with fixtures.
 */
export function CommentThread({
  comments,
  now,
}: {
  comments: TicketComment[];
  now: number;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="brief-comment-thread">
      {comments.map((comment) => {
        const isAgent = comment.authorKind === "agent";
        const ago = formatDuration(Math.max(0, now - comment.createdAtMs));
        return (
          <div
            key={comment.id}
            className="flex gap-3"
            data-testid="brief-comment"
            data-author-kind={comment.authorKind}
          >
            <span
              className={cn(
                "grid size-[26px] shrink-0 place-items-center rounded-full border border-(--glass-border-hairline) bg-(--color-bg-elevated) text-[11px] font-semibold",
                isAgent
                  ? "text-(--color-text-muted)"
                  : "text-(--color-text-secondary)",
              )}
            >
              {initial(comment.author)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[11px] text-(--color-text-muted)">
                <b className="text-[12px] font-semibold text-(--color-text-primary)">
                  {comment.author}
                </b>
                {isAgent && comment.role ? (
                  <span className="inline-flex h-[17px] items-center rounded-full border border-(--glass-border-hairline) bg-(--color-bg-input) px-2 text-[11px] font-medium capitalize text-(--color-text-primary)">
                    {comment.role}
                  </span>
                ) : null}
                <span>
                  · {isAgent ? "agent" : "you"} · {ago} ago
                </span>
              </div>
              <div className="whitespace-pre-wrap text-[12.5px] text-(--color-text-secondary)">
                {comment.body}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
