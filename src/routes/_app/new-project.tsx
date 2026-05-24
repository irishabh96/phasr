import { createFileRoute } from "@tanstack/react-router";
import { NewProjectPane } from "@/components/NewProjectPane";

export const Route = createFileRoute("/_app/new-project")({
  component: NewProjectPane,
});
