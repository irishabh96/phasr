import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { BoardView } from "@/components/board/BoardView";
import { PanelState } from "@/components/ui/PanelState";
import { useBoard, useBoardTaskEvents } from "@/lib/hooks/useBoard";

/**
 * The read-only task board (S2-T1). Fetches one parent's board via `get_board`
 * on mount, then stays fresh off the EXISTING `phasr://task-status` bus (no new
 * event — §C default (a)). Lanes are DERIVED (not draggable): every card's
 * column is a pure function of its honest state.
 *
 * Progressive disclosure (spec §B6/§F5): the board is a NEW route reached only
 * once a decomposition exists; the flat sidebar filters out parent/subtask
 * kinds (S2-T3), so the single-agent experience is untouched.
 */
function BoardRoute() {
  const { parentId } = Route.useParams();
  const { data: board, isLoading, error, refetch } = useBoard(parentId);

  const subtaskIds = useMemo(
    () => board?.subtasks.map((s) => s.id) ?? [],
    [board],
  );
  useBoardTaskEvents(parentId, subtaskIds);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5">
      {isLoading ? (
        <PanelState kind="loading" rows={4} />
      ) : error ? (
        <PanelState
          kind="error"
          title="Couldn't load the board"
          error={error}
          onRetry={() => void refetch()}
        />
      ) : board ? (
        <BoardView board={board} />
      ) : (
        <PanelState
          kind="empty"
          title="No board here"
          description="This decomposition no longer exists."
        />
      )}
    </div>
  );
}

export const Route = createFileRoute(
  "/_app/repositories/$repositoryId/board/$parentId",
)({
  component: BoardRoute,
});
