import {
  agentGlyph,
  agentKeyFromName,
  AGENT_GLYPH_COLOR,
} from "@/lib/agentIdentity";
import { formatDuration } from "@/lib/formatDuration";
import type { TicketComment } from "@/lib/types";
import { cn } from "@/lib/utils";

/** First letter of a name, uppercased — the avatar glyph (mockup Page 04). */
function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/**
 * The author avatar. Known agents (claude/codex/…) render their tinted brand
 * glyph so same-initial agents no longer collapse into an identical "C" circle;
 * humans and unrecognized authors keep the neutral initial. Identity only — the
 * tint is subtle and carries no status meaning.
 */
function AuthorAvatar({
  author,
  isAgent,
}: {
  author: string;
  isAgent: boolean;
}) {
  const agentKey = isAgent ? agentKeyFromName(author) : null;
  const base =
    "grid size-[26px] shrink-0 place-items-center rounded-full border bg-(--color-bg-elevated)";

  if (agentKey) {
    const color = AGENT_GLYPH_COLOR[agentKey];
    return (
      <span
        className={cn(base, "border-(--glass-border-hairline)")}
        style={{ borderColor: `color-mix(in oklab, ${color} 32%, transparent)` }}
      >
        <span
          aria-hidden="true"
          className="size-[15px]"
          style={{
            backgroundColor: color,
            WebkitMaskImage: `url("${agentGlyph(agentKey)}")`,
            maskImage: `url("${agentGlyph(agentKey)}")`,
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
          }}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        base,
        "border-(--glass-border-hairline) text-[11px] font-semibold",
        isAgent
          ? "text-(--color-text-muted)"
          : "text-(--color-text-secondary)",
      )}
    >
      {initial(author)}
    </span>
  );
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
            <AuthorAvatar author={comment.author} isAgent={isAgent} />
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
