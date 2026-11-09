import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";

import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./index.css";
import { routeTree } from "./routeTree.gen";
import { queryClient } from "./lib/query";
import {
  applyAccent,
  applyDensity,
  applyTheme,
  readStoredAccent,
  readStoredDensity,
  readStoredTheme,
} from "./lib/theme";
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

// Apply theme, accent and density before React mounts to prevent FOUC.
applyTheme(readStoredTheme());
applyAccent(readStoredAccent());
applyDensity(readStoredDensity());

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

// The terminal measures its cell box from the mono font the moment it mounts
// and hands cols/rows to the PTY; an agent TUI reads its size once. Mounting
// before the bundled fonts load would size every terminal against the
// fallback face. The faces are local (bundled), so this resolves in a frame
// or two; the cap only guards a broken font file.
const fontsReady = Promise.race([
  Promise.all([
    document.fonts.load('12px "JetBrains Mono"'),
    document.fonts.load('500 12px "JetBrains Mono"'),
    document.fonts.load('13px "Inter Variable"'),
  ]).catch(() => undefined),
  new Promise((resolve) => window.setTimeout(resolve, 1500)),
]);

void fontsReady.then(() => createRoot(rootElement, reactRootOptions).render(
  missingConfigMessages.length > 0 ? (
    <MissingRequiredConfig messages={missingConfigMessages} />
  ) : (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY!} appearance={clerkAppearance()}>
      {appTree}
    </ClerkProvider>
  ),
));

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
