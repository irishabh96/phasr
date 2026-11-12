import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { formatAgo } from "@/lib/board";
import { useNow } from "@/lib/hooks/useNow";
import type { ReviewComment } from "@/lib/types";

/**
 * A line's review thread inside the diff (A-Review): your comments on that
 * line, and the composer when you pressed + there. Pending comments go to
 * the agent with "Send all comments" in the inspector.
 */
export function CommentThread({
  comments,
  composing,
  busy,
  onSubmit,
  onCancel,
  onResolve,
  onDelete,
}: {
  comments: ReviewComment[];
  composing: boolean;
  busy: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  onResolve: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [body, setBody] = useState("");
  const now = useNow(false);
  return (
    <div className="card mx-3 my-1.5 flex flex-col gap-2 px-3 py-2.5 font-sans text-[12px] leading-[1.5]">
      {comments.map((c) => (
        <div key={c.id} className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-[12px] text-(--color-text-muted)">
            <span className="font-medium text-(--color-text-secondary)">You</span>
            {formatAgo(c.createdAt, now)}
            {c.status !== "pending" ? <span className="rounded-(--radius-chip) bg-(--color-bg-elevated) px-1">{c.status}</span> : null}
            <span className="flex-1" />
            {c.status !== "resolved" ? (
              <button type="button" onClick={() => onResolve(c.id)} className="hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:underline">
                Resolve
              </button>
            ) : null}
            <button type="button" onClick={() => onDelete(c.id)} className="hover:text-(--color-danger-text) focus-visible:outline-none focus-visible:underline">
              Delete
            </button>
          </span>
          <p className="m-0 whitespace-pre-wrap leading-[1.5] text-(--color-text-primary)">{c.body}</p>
        </div>
      ))}
      {composing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) onSubmit(body.trim());
          }}
        >
          <label className="sr-only" htmlFor="review-comment">
            Comment
          </label>
          <textarea
            id="review-comment"
            autoFocus
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (body.trim()) onSubmit(body.trim());
              }
              if (e.key === "Escape") onCancel();
            }}
            placeholder="Leave a comment for the agent…"
            className="resize-none rounded-(--radius-control) p-2 text-[12px]"
          />
          <span className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={busy || !body.trim()} shortcut="⌘↵">
              Comment
            </Button>
          </span>
        </form>
      ) : null}
    </div>
  );
}
