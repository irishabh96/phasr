import { defineConfig, type ServerOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

/**
 * `E2E_PORT` exists for probe isolation: Playwright's `reuseExistingServer`
 * happily reuses ANY dev server on 1420 — including another worktree's — and
 * then silently measures stale code. A perf run sets an explicit port so the
 * server under test is provably its own. Tauri dev keeps 1420
 * (`tauri.conf.json` hard-codes the devUrl).
 */
const port = Number(process.env.E2E_PORT) || 1420;

const server: ServerOptions = {
  port,
  strictPort: true,
  host: host || false,
  watch: {
    ignored: ["**/src-tauri/**"],
  },
};

if (host) {
  server.hmr = {
    protocol: "ws",
    host,
    port: 1421,
  };
}

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    // phasr ships in a Tauri webview (WKWebView / WebView2), so we can
    // target a modern baseline instead of the conservative default.
    target: "es2022",
    // Keep readable stacks in Sentry despite minification.
    sourcemap: true,
    // The Shiki grammar chunks are legitimately large; raise the warning
    // threshold so real regressions still surface.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // Isolate the heavy vendors into their own chunks so they cache
        // independently and (for the deferred ones) stay off first paint.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@sentry")) return "sentry";
          if (id.includes("@supabase")) return "supabase";
          if (id.includes("@clerk")) return "clerk";
          if (id.includes("shiki") || id.includes("@shikijs")) return "shiki";
          return undefined;
        },
      },
    },
  },

  clearScreen: false,
  server,
});
