import { createFileRoute } from "@tanstack/react-router";
import { WorkflowsIndex } from "@/components/board/WorkflowsIndex";

/**
 * The Workflows index — every active workflow in this repo (lane counts + the
 * derived next gate) over the Completed section (shipped/archived). The screen
 * that makes in-flight workflows findable after a relaunch.
 */
function WorkflowsIndexRoute() {
  const { repositoryId } = Route.useParams();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5">
      <WorkflowsIndex repositoryId={repositoryId} />
    </div>
  );
}

export const Route = createFileRoute("/_app/repositories/$repositoryId/board/")({
  component: WorkflowsIndexRoute,
});
