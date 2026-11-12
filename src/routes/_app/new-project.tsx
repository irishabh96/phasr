import { createFileRoute } from "@tanstack/react-router";
import { NewProjectPane } from "@/components/NewProjectPane";

type Mode = "empty" | "clone" | "template";

export const Route = createFileRoute("/_app/new-project")({
  component: NewProjectPane,
  // First run deep-links straight to a mode (A-FirstRun: Clone / New empty /
  // From a template).
  validateSearch: (search: Record<string, unknown>): { mode?: Mode } =>
    search.mode === "empty" || search.mode === "clone" || search.mode === "template" ? { mode: search.mode } : {},
});
