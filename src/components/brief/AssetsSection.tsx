import { convertFileSrc } from "@tauri-apps/api/core";
import { FileText, Loader2, Upload, X } from "lucide-react";
import { useState } from "react";
import { SectionCard } from "@/components/brief/SectionCard";
import { humanizeError } from "@/lib/humanizeError";
import type { TicketAsset } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Resolve an asset path to a webview-safe URL; null if it can't be resolved. */
function assetSrc(path: string): string | null {
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/**
 * The Assets strip (mockup Page 04): image thumbnails + typed chips for
 * PDFs/binaries, each with a remove affordance, plus a "Drop images / PDFs or
 * click to pick" dropzone. OS drag-drop is routed here by the shell-level
 * `useFileDrop` via the registered asset-drop target (Architect #3); the
 * dropzone click opens the Tauri file dialog. Pure & prop-driven so
 * `/design-test` renders it with fixtures.
 */
export function AssetsSection({
  assets,
  onPick,
  onRemove,
  uploading = false,
  uploadError,
}: {
  assets: TicketAsset[];
  onPick: () => void;
  onRemove: (id: string) => void;
  uploading?: boolean;
  uploadError?: unknown;
}) {
  return (
    <SectionCard title="Assets" testId="brief-assets">
      <div className="flex flex-wrap gap-2.5" data-testid="brief-assets-grid">
        {assets.map((asset) => (
          <AssetThumb key={asset.id} asset={asset} onRemove={onRemove} />
        ))}

        <button
          type="button"
          onClick={onPick}
          disabled={uploading}
          data-testid="brief-asset-dropzone"
          className={cn(
            "flex h-16 w-[150px] flex-col items-center justify-center gap-1 rounded-(--radius-control)",
            "border-[1.5px] border-dashed border-(--color-border-strong) text-center text-[11px] text-(--color-text-muted)",
            "transition-colors hover:border-(--color-accent-500) hover:text-(--color-text-secondary)",
            "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)] disabled:opacity-60",
          )}
        >
          {uploading ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Adding…
            </>
          ) : (
            <>
              <Upload className="size-4" aria-hidden="true" />
              <span>
                Drop images / PDFs
                <br />
                or click to pick
              </span>
            </>
          )}
        </button>
      </div>

      {uploadError ? (
        <p role="alert" className="mt-2 text-[11.5px] text-(--color-danger)">
          {humanizeError(uploadError)}
        </p>
      ) : null}
    </SectionCard>
  );
}

function AssetThumb({
  asset,
  onRemove,
}: {
  asset: TicketAsset;
  onRemove: (id: string) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = asset.kind === "image" ? assetSrc(asset.path) : null;
  const showImage = asset.kind === "image" && src && !imgFailed;

  return (
    <div
      data-testid="brief-asset"
      data-asset-kind={asset.kind}
      className="group/asset relative flex h-16 w-[88px] items-end overflow-hidden rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-elevated)"
    >
      {showImage ? (
        <img
          src={src}
          alt={asset.name}
          onError={() => setImgFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center",
            asset.kind === "pdf"
              ? "text-(--color-danger)"
              : "text-(--color-text-muted)",
          )}
        >
          <FileText className="size-5" aria-hidden="true" />
        </span>
      )}

      <span className="relative z-10 w-full truncate bg-[color-mix(in_oklab,var(--color-bg-base)_55%,transparent)] px-1.5 py-0.5 font-mono text-[9.5px] text-(--color-text-secondary)">
        {asset.name}
      </span>

      <button
        type="button"
        onClick={() => onRemove(asset.id)}
        aria-label={`Remove ${asset.name}`}
        data-testid="brief-asset-remove"
        className="absolute right-1 top-1 z-20 grid size-5 place-items-center rounded-full bg-(--color-bg-overlay) text-(--color-text-primary) opacity-0 transition-opacity hover:bg-(--color-danger) hover:text-(--color-text-inverse) focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)] group-hover/asset:opacity-100"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
