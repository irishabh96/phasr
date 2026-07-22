import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { PanelState } from "@/components/ui/PanelState";
import { AgentWorkingBanner } from "@/components/brief/AgentWorkingBanner";
import { AssetsSection } from "@/components/brief/AssetsSection";
import { FigmaSection } from "@/components/brief/FigmaSection";
import { SectionEditor } from "@/components/brief/SectionEditor";
import { useAgentLiveness } from "@/lib/agentLiveness";
import { deriveAgentState } from "@/lib/deriveAgentState";
import { useAssetDropTarget } from "@/lib/hooks/useAssetDropTarget";
import { ticketBriefKeys, useTicketBrief } from "@/lib/hooks/useTicketBrief";
import { humanizeError } from "@/lib/humanizeError";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import { useNow } from "@/lib/useNow";
import type {
  BriefSectionContent,
  TicketBrief,
  TicketChangedPayload,
  Workspace,
} from "@/lib/types";

const ASSET_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "pdf",
  "fig",
  "mp4",
  "mov",
  "zip",
];

/**
 * The Brief tab (mockup Page 04, stories F3–F5). Reads the versioned brief and
 * renders it read-first: an ambient "agent is working" banner (F4), the three
 * markdown sections (Description / PRD / TRD) with per-section edit + conflict
 * handling, an Assets strip (drag-drop + picker), and a Figma link list.
 *
 * Co-editing honesty (F4): while visible it watches the ticket dir
 * (`watch_ticket`) and soft-refreshes on `phasr://ticket-changed`; a concurrent
 * on-disk edit to a section being edited raises the Reload / Keep-mine prompt
 * (never a silent overwrite). Assets: the OS drag-drop target is registered
 * ONLY while this tab is visible (Architect #3).
 */
export function BriefPanel({
  repositoryId,
  ticketId,
  workspace,
  visible,
}: {
  repositoryId: string;
  ticketId: string;
  workspace: Workspace;
  visible: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useTicketBrief(repositoryId, ticketId);
  const brief = query.data;
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);

  const briefKey = ticketBriefKeys.detail(repositoryId, ticketId);
  const patchBrief = useCallback(
    (fn: (b: TicketBrief) => TicketBrief) =>
      queryClient.setQueryData<TicketBrief>(briefKey, (prev) =>
        prev ? fn(prev) : prev,
      ),
    [queryClient, briefKey],
  );

  // ── co-editing honesty: is THIS ticket's agent live? (F4) ────────────────
  const live = useAgentLiveness(ticketId);
  const now = useNow(workspace.status === "running");
  const agentState = deriveAgentState(workspace, live, now).state;
  const agentWorking =
    agentState === "working" ||
    agentState === "idle" ||
    agentState === "resolving";

  // ── watch the ticket dir + soft-refresh on external change (F4) ───────────
  useEffect(() => {
    if (!visible) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void tauri.watchTicket(repositoryId, ticketId).catch(() => {});
    void listen<TicketChangedPayload>("phasr://ticket-changed", (event) => {
      if (event.payload.ticketId !== ticketId) return;
      // Refetch the brief; each SectionEditor soft-refreshes (read mode) or
      // raises its conflict prompt (edit mode) off the fresh on-disk content.
      void queryClient.invalidateQueries({ queryKey: briefKey });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      void tauri.unwatchTicket(repositoryId, ticketId).catch(() => {});
    };
  }, [visible, repositoryId, ticketId, queryClient, briefKey]);

  // ── assets: shared add-paths path for drop + picker ──────────────────────
  const addAssetPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setUploading(true);
      setUploadError(null);
      try {
        for (const path of paths) {
          const asset = await tauri.addTicketAsset(
            repositoryId,
            ticketId,
            path,
          );
          patchBrief((b) => ({ ...b, assets: [...b.assets, asset] }));
        }
      } catch (e) {
        setUploadError(e);
      } finally {
        setUploading(false);
      }
    },
    [repositoryId, ticketId, patchBrief],
  );

  // OS drag-drop is routed here by `useFileDrop` — but ONLY while visible.
  useAssetDropTarget(visible, (paths) => void addAssetPaths(paths));

  const onPick = useCallback(async () => {
    try {
      const picked = await open({
        multiple: true,
        filters: [{ name: "Images & PDFs", extensions: ASSET_EXTENSIONS }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      await addAssetPaths(paths);
    } catch (e) {
      setUploadError(e);
    }
  }, [addAssetPaths]);

  const onRemoveAsset = useCallback(
    async (assetId: string) => {
      const prev = queryClient.getQueryData<TicketBrief>(briefKey);
      patchBrief((b) => ({
        ...b,
        assets: b.assets.filter((a) => a.id !== assetId),
      }));
      try {
        await tauri.removeTicketAsset(repositoryId, ticketId, assetId);
      } catch (e) {
        if (prev) queryClient.setQueryData(briefKey, prev);
        showToast({
          title: "Couldn't remove asset",
          intent: "error",
          message: humanizeError(e),
        });
      }
    },
    [repositoryId, ticketId, queryClient, briefKey, patchBrief],
  );

  const onAddFigma = useCallback(
    async (url: string, label: string | null) => {
      try {
        const link = await tauri.addTicketFigmaLink(
          repositoryId,
          ticketId,
          url,
          label,
        );
        patchBrief((b) => ({ ...b, figma: [...b.figma, link] }));
      } catch (e) {
        showToast({
          title: "Couldn't add Figma link",
          intent: "error",
          message: humanizeError(e),
        });
      }
    },
    [repositoryId, ticketId, patchBrief],
  );

  const onRemoveFigma = useCallback(
    async (linkId: string) => {
      const prev = queryClient.getQueryData<TicketBrief>(briefKey);
      patchBrief((b) => ({
        ...b,
        figma: b.figma.filter((l) => l.id !== linkId),
      }));
      try {
        await tauri.removeTicketFigmaLink(repositoryId, ticketId, linkId);
      } catch (e) {
        if (prev) queryClient.setQueryData(briefKey, prev);
        showToast({
          title: "Couldn't remove Figma link",
          intent: "error",
          message: humanizeError(e),
        });
      }
    },
    [repositoryId, ticketId, queryClient, briefKey, patchBrief],
  );

  const onSectionSaved = useCallback(
    (sectionKey: "description" | "prd" | "trd", section: BriefSectionContent) =>
      patchBrief((b) => ({ ...b, [sectionKey]: section })),
    [patchBrief],
  );

  // ── states ───────────────────────────────────────────────────────────────
  if (query.isError) {
    return (
      <div className="mx-auto max-w-[760px] px-5 py-6">
        <PanelState
          kind="error"
          title="Couldn't load the brief"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  if (query.isLoading || !brief) {
    return (
      <div className="mx-auto max-w-[760px] px-5 py-6">
        <PanelState kind="loading" rows={4} />
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-y-auto"
      data-testid="brief-panel"
      data-visible={visible}
    >
      <div className="mx-auto flex max-w-[720px] flex-col px-6 py-6">
        {agentWorking ? (
          <div className="mb-6">
            <AgentWorkingBanner />
          </div>
        ) : null}

        {/* The brief as a reading document: borderless prose sections with real
            rhythm (24px between them), each lifting into an edit card in place. */}
        <div className="flex flex-col gap-6">
          <SectionEditor
            repositoryId={repositoryId}
            ticketId={ticketId}
            sectionKey="description"
            label="Description"
            section={brief.description}
            onSaved={(s) => onSectionSaved("description", s)}
          />
          <SectionEditor
            repositoryId={repositoryId}
            ticketId={ticketId}
            sectionKey="prd"
            label="PRD"
            section={brief.prd}
            onSaved={(s) => onSectionSaved("prd", s)}
          />
          <SectionEditor
            repositoryId={repositoryId}
            ticketId={ticketId}
            sectionKey="trd"
            label="TRD"
            section={brief.trd}
            onSaved={(s) => onSectionSaved("trd", s)}
          />
        </div>

        {/* Attachments — object galleries kept as calm cards, set off from the
            prose above by a single hairline. */}
        <div className="mt-7 flex flex-col gap-4 border-t border-(--color-border-subtle) pt-7">
          <AssetsSection
            assets={brief.assets}
            onPick={() => void onPick()}
            onRemove={(id) => void onRemoveAsset(id)}
            uploading={uploading}
            uploadError={uploadError}
          />

          <FigmaSection
            links={brief.figma}
            onAdd={(url, label) => void onAddFigma(url, label)}
            onRemove={(id) => void onRemoveFigma(id)}
          />
        </div>
      </div>
    </div>
  );
}
