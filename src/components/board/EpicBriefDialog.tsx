import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { GlassButton } from "@/components/ui/GlassButton";
import { humanizeError } from "@/lib/humanizeError";
import { tauri } from "@/lib/tauri";
import type { BriefSection, BriefSectionContent } from "@/lib/types";

/**
 * The workflow-brief edit surface (E5, "fast-follow" since phase2b — landed in
 * Phase 8 of the completion program). Epic docs were WRITE-ONCE at decompose
 * time; every ticket inherits them, so a mid-flight correction had nowhere to
 * go. Two sections (PRD / TRD), each saved independently with the SAME
 * optimistic-concurrency contract as ticket sections: a stale base never
 * clobbers — the conflict banner offers Reload (take disk) / Keep mine
 * (re-save over it, now against the fresh base).
 *
 * NOTE the honest boundary: agents read these docs when they SPAWN. An edit
 * reaches future spawns/respawns, not agents already running — the helper
 * line under the title says so.
 */
export function EpicBriefDialog({
  repositoryId,
  parentId,
  open,
  onClose,
}: {
  repositoryId: string;
  parentId: string;
  open: boolean;
  onClose(): void;
}) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prd, setPrd] = useState<BriefSectionContent | null>(null);
  const [trd, setTrd] = useState<BriefSectionContent | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    tauri
      .readEpicBrief(repositoryId, parentId)
      .then((brief) => {
        if (cancelled) return;
        setPrd(brief.prd);
        setTrd(brief.trd);
      })
      .catch((err) => !cancelled && setLoadError(humanizeError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, repositoryId, parentId]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="min(720px, 92vw)"
      title="Workflow brief"
      description="The PRD/TRD every ticket inherits. Edits reach agents on their next spawn or re-spawn — not ones already running."
    >
      {loading ? (
        <p className="py-6 text-center text-[12px] text-(--color-text-muted)">
          Loading…
        </p>
      ) : loadError ? (
        <p role="alert" className="rounded-md border border-[color-mix(in_oklab,var(--color-danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-3 py-2 text-[11.5px] text-(--color-danger)">
          {loadError}
        </p>
      ) : (
        <div className="space-y-4">
          {prd && (
            <SectionEditor
              label="PRD"
              section="prd"
              repositoryId={repositoryId}
              parentId={parentId}
              initial={prd}
            />
          )}
          {trd && (
            <SectionEditor
              label="TRD"
              section="trd"
              repositoryId={repositoryId}
              parentId={parentId}
              initial={trd}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}

function SectionEditor({
  label,
  section,
  repositoryId,
  parentId,
  initial,
}: {
  label: string;
  section: BriefSection;
  repositoryId: string;
  parentId: string;
  initial: BriefSectionContent;
}) {
  const [content, setContent] = useState(initial.content);
  const [baseMtimeMs, setBaseMtimeMs] = useState(initial.mtimeMs);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BriefSectionContent | null>(null);

  const dirty = content !== initial.content || saved === false;

  const save = async (base: number | null) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await tauri.writeEpicSection(
        repositoryId,
        parentId,
        section,
        content,
        base,
      );
      if (result.kind === "saved") {
        setBaseMtimeMs(result.section.mtimeMs);
        setConflict(null);
        setSaved(true);
      } else {
        setConflict(result.onDisk);
      }
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-(--color-text-muted)">
          {label}
        </h3>
        <GlassButton
          variant="outline"
          size="sm"
          onClick={() => void save(baseMtimeMs)}
          disabled={saving || !dirty}
        >
          {saving ? (
            <>
              <Loader2 size={12} className="animate-spin" aria-hidden />
              Saving…
            </>
          ) : saved ? (
            <>
              <Check size={12} aria-hidden />
              Saved
            </>
          ) : (
            "Save"
          )}
        </GlassButton>
      </div>
      <textarea
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setSaved(false);
        }}
        rows={8}
        aria-label={`${label} content`}
        className="w-full resize-y rounded-(--radius-control) border border-(--glass-border-hairline) bg-(--color-bg-input) px-3 py-2 font-mono text-[12px] leading-relaxed text-(--color-text-primary) outline-none focus-visible:border-(--color-accent-500) focus-visible:shadow-[var(--ring-focus)]"
      />
      {conflict && (
        <div role="alert" className="space-y-2 rounded-md border border-[color-mix(in_oklab,var(--color-warning)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_8%,transparent)] px-3 py-2">
          <p className="text-[11.5px] text-(--color-text-primary)">
            This section changed on disk since you opened it. Nothing was
            overwritten.
          </p>
          <div className="flex gap-2">
            <GlassButton
              variant="outline"
              size="sm"
              onClick={() => {
                setContent(conflict.content);
                setBaseMtimeMs(conflict.mtimeMs);
                setConflict(null);
              }}
            >
              Reload theirs
            </GlassButton>
            <GlassButton
              variant="outline"
              size="sm"
              onClick={() => void save(conflict.mtimeMs)}
            >
              Keep mine
            </GlassButton>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[11.5px] text-(--color-danger)">
          {error}
        </p>
      )}
    </section>
  );
}
