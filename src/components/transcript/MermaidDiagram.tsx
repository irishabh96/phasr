import { useEffect, useId, useState } from "react";
import { useUiStore } from "@/lib/store";
import { resolveTheme } from "@/lib/theme";

/**
 * A ```mermaid block an agent wrote, drawn as a diagram.
 *
 * Mermaid is large, so it is imported the first time a diagram appears,
 * never at boot. `securityLevel: "strict"` sanitises the SVG (no scripts,
 * no click handlers, HTML labels escaped) — the source is agent output.
 * Anything that fails to parse shows its source instead, as before.
 */

type MermaidApi = typeof import("mermaid").default;
let loading: Promise<MermaidApi> | null = null;
let configuredFor: string | null = null;

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

export function MermaidDiagram({ source, fallback }: { source: string; fallback: React.ReactNode }) {
  const theme = resolveTheme(useUiStore((s) => s.theme));
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void loadMermaid()
      .then(async (mermaid) => {
        if (configuredFor !== theme) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: theme === "dark" ? "dark" : "neutral",
            fontFamily: "var(--font-sans)",
          });
          configuredFor = theme;
        }
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        // Mermaid leaves its error graphic in the document on a failed render.
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, source, theme]);

  if (failed || svg === null) return <>{fallback}</>;
  return (
    <div
      role="img"
      aria-label="Diagram"
      className="overflow-x-auto rounded-(--radius-control) bg-(--color-bg-input) px-[12px] py-[10px] [&_svg]:h-auto [&_svg]:max-w-full"
      // Sanitised by mermaid (securityLevel "strict").
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
