import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";

import "./index.css";
import { routeTree } from "./routeTree.gen";
import { queryClient } from "./lib/query";
import { applyTheme, readStoredTheme } from "./lib/theme";
import { CLERK_PUBLISHABLE_KEY, clerkAppearance } from "./lib/clerk";

// Apply theme before React mounts to prevent FOUC.
applyTheme(readStoredTheme());

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element in index.html");
}

createRoot(rootElement).render(
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} appearance={clerkAppearance()}>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </ClerkProvider>,
);
