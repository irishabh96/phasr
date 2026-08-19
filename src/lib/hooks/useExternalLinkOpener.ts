import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";

/**
 * Route genuinely EXTERNAL `<a href>` clicks to the default browser.
 *
 * Inside the Tauri webview a plain anchor click either navigates the
 * webview away from the app or is blocked by CSP — both wrong. One
 * capture-phase listener at the shell makes external links behave like
 * links everywhere (briefs, toasts, notes) without per-component wiring.
 *
 * The test is CROSS-ORIGIN, not the scheme. Testing `http(s)://` alone
 * swallowed every in-app <Link> under `pnpm tauri dev`, where the app's
 * own origin IS `http://localhost:1420` — clicking a sidebar row handed
 * the app's own route to the OS and the router never moved. Packaged
 * builds hid it because there the origin is `tauri://localhost`.
 *
 * The scheme check stays as a guard on what we hand the OS: only ever
 * http(s), never an arbitrary scheme from rendered content.
 */
export function useExternalLinkOpener(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      // Only ever hand the OS an http(s) URL.
      const href = anchor.href;
      if (!href.startsWith("http://") && !href.startsWith("https://")) return;

      // Same-origin means it's an in-app route — let the router have it.
      // `target="_blank"` is an explicit opt-out for same-origin links
      // that really are meant to leave the app.
      let isExternal: boolean;
      try {
        isExternal = new URL(href).origin !== window.location.origin;
      } catch {
        return;
      }
      if (!isExternal && anchor.target !== "_blank") return;

      e.preventDefault();
      void openUrl(href);
    };
    window.addEventListener("click", onClick, { capture: true });
    return () => window.removeEventListener("click", onClick, { capture: true });
  }, []);
}
