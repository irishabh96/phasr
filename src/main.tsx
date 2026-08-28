import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";

import "./index.css";
import { routeTree } from "./routeTree.gen";
import { queryClient } from "./lib/query";
import { applyTheme, readStoredTheme } from "./lib/theme";
import {
  CLERK_CONFIG_ERROR,
  CLERK_PUBLISHABLE_KEY,
  clerkAppearance,
  isClerkConfigured,
} from "./lib/clerk";
import {
  isSupabaseConfigured,
  SUPABASE_CONFIG_ERROR,
} from "./lib/supabase";
import {
  initSentry,
  isSentryConfigured,
  sentryReactRootErrorHandler,
} from "./lib/sentry";

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

const appTree = (
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);

function MissingRequiredConfig({ messages }: { messages: string[] }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) px-6 text-(--color-text-primary)">
      <div className="w-full max-w-xl rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 shadow-xl">
        <h1 className="text-lg font-semibold">Phasr requires cloud configuration</h1>
        <div className="mt-3 space-y-2 text-sm text-(--color-text-secondary)">
          {messages.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

const missingConfigMessages = [
  ...(isClerkConfigured ? [] : [CLERK_CONFIG_ERROR]),
  ...(isSupabaseConfigured ? [] : [SUPABASE_CONFIG_ERROR]),
];

const reactRootOptions: Parameters<typeof createRoot>[1] = isSentryConfigured
  ? {
      onCaughtError: sentryReactRootErrorHandler,
      onRecoverableError: sentryReactRootErrorHandler,
      onUncaughtError: sentryReactRootErrorHandler,
    }
  : undefined;

createRoot(rootElement, reactRootOptions).render(
  missingConfigMessages.length > 0 ? (
    <MissingRequiredConfig messages={missingConfigMessages} />
  ) : (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY!} appearance={clerkAppearance()}>
      {appTree}
    </ClerkProvider>
  ),
);

// Defer Sentry off the first-paint path. `@sentry/react` is heavy and
// isn't needed to render the initial UI, so we dynamically load and
// initialise it after the first frame via an idle callback. The DSN gate
// still lives inside `initSentry`.
function initSentryWhenIdle() {
  const start = () => {
    void initSentry(router);
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(start);
  } else {
    window.setTimeout(start, 0);
  }
}

initSentryWhenIdle();

// Perf Phase 0: the Rust↔JS IPC bench self-runs when the real shell was
// launched with PHASR_IPC_BENCH=1 (`src-tauri/src/ipcbench.rs`). Dev
// builds only — the import is compile-time dead in production — and a
// no-op in a plain browser or a normally-launched shell.
if (import.meta.env.DEV) {
  void import("./lib/perf/ipcBench").then((m) => m.runIpcBenchIfRequested());
}
