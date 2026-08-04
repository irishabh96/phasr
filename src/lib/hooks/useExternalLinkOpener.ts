import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";

/**
 * Route every rendered `<a href="http(s)://…">` to the default browser.
 *
 * Inside the Tauri webview a plain anchor click either navigates the
 * webview away from the app or is blocked by CSP — both wrong. One
 * capture-phase listener at the shell makes external links behave like
 * links everywhere (briefs, toasts, notes) without per-component wiring.
 */
export function useExternalLinkOpener(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.href;
      if (!href.startsWith("http://") && !href.startsWith("https://")) return;
      e.preventDefault();
      void openUrl(href);
    };
    window.addEventListener("click", onClick, { capture: true });
    return () => window.removeEventListener("click", onClick, { capture: true });
  }, []);
}
