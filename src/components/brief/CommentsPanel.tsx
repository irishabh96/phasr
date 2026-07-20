import { useQueryClient } from "@tanstack/react-query";
import { SendHorizonal } from "lucide-react";
import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";
import { PanelState } from "@/components/ui/PanelState";
import { CommentThread } from "@/components/brief/CommentThread";
import {
  ticketBriefKeys,
  useTicketComments,
} from "@/lib/hooks/useTicketBrief";
import { humanizeError } from "@/lib/humanizeError";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import { useNow } from "@/lib/useNow";
import type { TicketComment } from "@/lib/types";

/**
 * The Comments tab (spec F5) — the ticket's discussion thread + a composer.
 * Human vs agent entries render distinctly (mockup Page 04). Appends are
 * optimistic (a temp row appears immediately) and roll back with a humanized
 * toast on failure. Agent comments are read-only in Phase 2 (they arrive via a
 * `phasr://ticket-changed` re-read; the CLI writes them in Phase 3).
 */
export function CommentsPanel({
  repositoryId,
  ticketId,
  visible,
}: {
  repositoryId: string;
  ticketId: string;
  visible: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useTicketComments(repositoryId, ticketId, visible);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const now = useNow(visible);

  const key = ticketBriefKeys.comments(repositoryId, ticketId);

  const submit = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);

    const temp: TicketComment = {
      id: `temp-${uuidv4()}`,
      author: "You",
      authorKind: "you",
      role: null,
      body: text,
      createdAtMs: Date.now(),
    };
    // Optimistic append.
    queryClient.setQueryData<TicketComment[]>(key, (prev) => [
      ...(prev ?? []),
      temp,
    ]);
    setBody("");

    try {
      const saved = await tauri.addTicketComment(repositoryId, ticketId, text);
      // Replace the temp row with the real one.
      queryClient.setQueryData<TicketComment[]>(key, (prev) =>
        (prev ?? []).map((c) => (c.id === temp.id ? saved : c)),
      );
      // Keep the brief's commentCount badge in step.
      queryClient.invalidateQueries({
        queryKey: ticketBriefKeys.detail(repositoryId, ticketId),
      });
    } catch (e) {
      // Roll the optimistic row back.
      queryClient.setQueryData<TicketComment[]>(key, (prev) =>
        (prev ?? []).filter((c) => c.id !== temp.id),
      );
      setBody(text);
      showToast({
        title: "Couldn't post comment",
        intent: "error",
        message: humanizeError(e),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {query.isError ? (
          <PanelState
            kind="error"
            title="Couldn't load comments"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : query.isLoading ? (
          <PanelState kind="loading" rows={3} />
        ) : (query.data?.length ?? 0) === 0 ? (
          <PanelState
            kind="empty"
            title="No comments yet"
            description="Leave the first note — the agent reads the brief, and you can steer it here."
          />
        ) : (
          <CommentThread comments={query.data ?? []} now={now} />
        )}
      </div>

      <div className="shrink-0 border-t border-(--color-border-subtle) p-3">
        <GlassTextarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="Leave a note… (⌘↵ to send)"
          aria-label="New comment"
          data-testid="comment-composer"
          className="text-[12.5px]"
        />
        <div className="mt-2 flex justify-end">
          <GlassButton
            variant="primary"
            size="sm"
            disabled={sending || body.trim() === ""}
            onClick={() => void submit()}
            data-testid="comment-send"
          >
            <SendHorizonal className="size-3.5" aria-hidden="true" />
            {sending ? "Sending…" : "Comment"}
          </GlassButton>
        </div>
      </div>
    </div>
  );
}
