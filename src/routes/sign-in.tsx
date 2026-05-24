import { createFileRoute } from "@tanstack/react-router";
import { DesktopSignIn } from "@/components/DesktopSignIn";

export const Route = createFileRoute("/sign-in")({
  component: DesktopSignIn,
});
