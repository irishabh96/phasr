import { defineConfig, type Plugin, type ServerOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Move the build's sourcemaps out of the output dir into a sibling
 * `<outDir>-sourcemaps/` (i.e. `dist-sourcemaps/`).
 *
 * Tauri embeds everything under `frontendDist` (`../dist`) into the app
 * binary, so maps left there shipped ~12 MB inside every install while
 * doing nothing for Sentry, which can't fetch them from the app origin.
 * With `sourcemap: "hidden"` the JS carries no `sourceMappingURL`, and
 * the maps stay on disk next to `dist/` for a symbolication upload step.
 */
function relocateSourcemaps(): Plugin {
  return {
    name: "phasr:relocate-sourcemaps",
    apply: "build",
    writeBundle: {
      order: "post",
      sequential: true,
      handler(options, bundle) {
        if (!options.dir) return;
        const mapsDir = `${path.resolve(options.dir)}-sourcemaps`;
        rmSync(mapsDir, { recursive: true, force: true });
        for (const fileName of Object.keys(bundle)) {
          if (!fileName.endsWith(".map")) continue;
          const target = path.join(mapsDir, fileName);
          mkdirSync(path.dirname(target), { recursive: true });
          renameSync(path.join(options.dir, fileName), target);
        }
      },
    },
  };
}

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
    relocateSourcemaps(),
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
    // Emitted for symbolicating Sentry stacks, but "hidden" (no
    // sourceMappingURL comment) and moved out of dist/ by
    // relocateSourcemaps() so they never ship inside the app bundle.
    // Nothing uploads them yet; Sentry needs an upload step for that.
    sourcemap: "hidden",
    // A few vendor chunks (CodeMirror, ghostty-web) are legitimately
    // large; raise the warning threshold so real regressions still surface.
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
