import { defineConfig, type ServerOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

const host = process.env.TAURI_DEV_HOST;

const server: ServerOptions = {
  port: 1420,
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
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
    // Never base64-inline fonts into the render-blocking CSS: they're read
    // from the local app bundle anyway, and inlining makes every launch
    // parse them even when unicode-range would skip the file. Other assets
    // keep Vite's default 4 KB threshold.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined),
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
          // Grammars stay out of the shared "shiki" chunk: each is its own
          // dynamic import in lib/diff/shiki.ts, loaded per language.
          if (id.includes("@shikijs/langs")) return undefined;
          if (id.includes("shiki") || id.includes("@shikijs")) return "shiki";
          return undefined;
        },
      },
    },
  },

  clearScreen: false,
  server,
});
