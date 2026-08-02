import { openUrl } from "@tauri-apps/plugin-opener";
import { LayoutTemplate, Plus, X } from "lucide-react";
import { useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { SectionCard } from "@/components/brief/SectionCard";
import type { FigmaLink } from "@/lib/types";

/** A lenient URL guard — good enough to reject obvious junk before the backend. */
function isLikelyUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Trim a URL to a compact host+path label (mockup `figma.com/file/… · Panel`). */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * The Figma section (mockup Page 04) — link-only v1 (open decision #5): a
 * neutral link chip per linked file, an "Add link" inline form, and per-id
 * remove. Link-chips-only by design — no thumbnails: broken/opaque links
 * degrade gracefully (we never fetch a preview). Pure & prop-driven for
 * `/design-test`.
 */
export function FigmaSection({
  links,
  onAdd,
  onRemove,
}: {
  links: FigmaLink[];
  onAdd: (url: string, label: string | null) => void;
  onRemove: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!isLikelyUrl(url)) {
      setError("Enter a valid http(s) link.");
      return;
    }
    onAdd(url.trim(), label.trim() || null);
    setUrl("");
    setLabel("");
    setError(null);
    setAdding(false);
  };

  const action = (
    <button
      type="button"
      onClick={() => setAdding((v) => !v)}
      data-testid="brief-figma-add-toggle"
      className="inline-flex items-center gap-1.5 rounded-[6px] text-[11px] text-(--color-text-muted) transition-colors hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
    >
      <Plus className="size-3" aria-hidden="true" />
      Add link
    </button>
  );

  return (
    <SectionCard title="Figma" testId="brief-figma" action={action}>
      {adding ? (
        <div className="mb-3 flex flex-col gap-2" data-testid="brief-figma-form">
          <GlassInput
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="https://figma.com/file/…"
            aria-label="Figma URL"
            data-testid="brief-figma-url"
            className="h-8 text-[12px]"
          />
          <GlassInput
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional) — e.g. Comments panel"
            aria-label="Figma label"
            className="h-8 text-[12px]"
          />
          {error ? (
            <p role="alert" className="text-[11.5px] text-(--color-danger)">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <GlassButton
              variant="ghost"
              size="sm"
              onClick={() => setAdding(false)}
            >
              Cancel
            </GlassButton>
            <GlassButton
              variant="outline"
              size="sm"
              onClick={submit}
              data-testid="brief-figma-submit"
            >
              Add link
            </GlassButton>
          </div>
        </div>
      ) : null}

      {links.length === 0 && !adding ? (
        <p className="text-[12px] text-(--color-text-muted)">
          No design links yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {links.map((link) => (
            <div
              key={link.id}
              className="group/figma flex items-center gap-3"
              data-testid="brief-figma-link"
            >
              <div className="flex h-16 w-[110px] shrink-0 items-center justify-center rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-elevated) text-(--color-cyan)">
                <LayoutTemplate className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  title={link.url}
                  onClick={() => void openUrl(link.url).catch(() => {})}
                  className="block max-w-full truncate text-left font-mono text-[11.5px] text-(--color-accent-text) hover:underline focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                >
                  {shortUrl(link.url)}
                  {link.label ? ` · ${link.label}` : ""}
                </button>
                <div className="mt-0.5 text-[11px] text-(--color-text-muted)">
                  {link.addedBy === "you" ? "linked by you" : "linked"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(link.id)}
                aria-label="Remove Figma link"
                data-testid="brief-figma-remove"
                className="grid size-6 place-items-center rounded-full text-(--color-text-muted) opacity-0 transition-opacity hover:bg-(--color-bg-hover) hover:text-(--color-danger) focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)] group-hover/figma:opacity-100"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
