import { createFileRoute } from "@tanstack/react-router";
import { WorklistView } from "@/components/worklist/WorklistView";

/**
 * `/worklist` — the cross-repo attention Home (mockup Page 01, stories F1/F2).
 * Reached by the permanent sidebar Home entry, the `⌘⇧H` shortcut, and as the
 * `/` fallback for users with no valid last-workspace (returning users still
 * auto-restore — see `_app/index.tsx`).
 */
export const Route = createFileRoute("/_app/worklist")({
  component: WorklistView,
});
