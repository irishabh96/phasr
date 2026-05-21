import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DiffList } from "@/components/diff/DiffList";
import { RawDiffViewer } from "@/components/diff/RawDiffViewer";
import { SAMPLE_DIFFS, SAMPLE_DIFF_LIST, type SampleDiff } from "@/components/diff/sampleDiffs";
import { GlassButton } from "@/components/ui/GlassButton";
import { cn } from "@/lib/utils";

type PreviewTab = "single" | "list";

/**
 * Dev-only preview route. Gated behind `import.meta.env.DEV` so it
 * never ships in the Tauri bundle. Switches between the single-file
 * viewer (DiffView) and the multi-file collapsible list (DiffList).
 */
function DiffPreview() {
  const [tab, setTab] = useState<PreviewTab>("single");
  const [active, setActive] = useState<SampleDiff>(SAMPLE_DIFFS[0] as SampleDiff);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border-subtle) px-4 py-2 text-[12px]">
        <span className="font-medium text-(--color-text-primary)">
          Diff viewer preview
        </span>
        <span className="text-(--color-text-muted)">
          Press ⌘\ (or Ctrl\) to flip Split / Inline
        </span>
        <div className="ml-auto flex items-center gap-1">
          <GlassButton
            variant={tab === "single" ? "outline" : "ghost"}
            size="sm"
            onClick={() => setTab("single")}
            aria-pressed={tab === "single"}
          >
            Single file
          </GlassButton>
          <GlassButton
            variant={tab === "list" ? "outline" : "ghost"}
            size="sm"
            onClick={() => setTab("list")}
            aria-pressed={tab === "list"}
          >
            File list
          </GlassButton>
        </div>
      </div>

      {tab === "single" ? (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-56 shrink-0 flex-col border-r border-(--color-border-subtle) p-2">
            {SAMPLE_DIFFS.map((sample) => (
              <GlassButton
                key={sample.id}
                variant={sample.id === active.id ? "outline" : "ghost"}
                size="sm"
                onClick={() => setActive(sample)}
                className={cn("w-full justify-start text-left")}
              >
                <span className="truncate">{sample.label}</span>
              </GlassButton>
            ))}
          </aside>
          <div className="min-w-0 flex-1">
            <RawDiffViewer
              key={active.id}
              raw={active.raw}
              filePath={active.filePath}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <DiffList
            files={SAMPLE_DIFF_LIST.map((f) => ({ path: f.path, raw: f.raw }))}
            onCopyPath={(p) => console.info("[preview] copy", p)}
            onComment={(p) => console.info("[preview] comment", p)}
            onDiscard={(p) => console.info("[preview] discard", p)}
            onOpen={(p) => console.info("[preview] open", p)}
          />
        </div>
      )}
    </div>
  );
}

function DiffPreviewGate() {
  if (!import.meta.env.DEV) {
    return <Navigate to="/" replace />;
  }
  return <DiffPreview />;
}

export const Route = createFileRoute("/_app/dev/diff-preview")({
  component: DiffPreviewGate,
});
