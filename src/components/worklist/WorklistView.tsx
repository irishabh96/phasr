import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2, FolderGit2, Search } from "lucide-react";
import {
  AutopilotHaltedBanner,
  HaltAutopilotButton,
} from "@/components/AutopilotHaltedBanner";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassInput } from "@/components/ui/GlassInput";
import { PanelState } from "@/components/ui/PanelState";
import { WorklistRow } from "@/components/worklist/WorklistRow";
import { useAllAgentLiveness } from "@/lib/agentLiveness";
import {
  buildWorklistItems,
  worklistHasLiveRow,
  WORKLIST_BUCKET_LABEL,
  WORKLIST_BUCKET_ORDER,
  type WorklistItem,
} from "@/lib/deriveWorklist";
import { useWorklist } from "@/lib/hooks/useWorklist";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import type { WorklistState } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * How many rows a single bucket renders before collapsing behind a "Show all"
 * expander. Keeps the surface scannable at 100s of rows without a full
 * virtualiser (spec §G — scale). Keyboard nav only ever traverses the VISIBLE
 * rows, so an un-expanded overflow is never a silent dead spot.
 */
const BUCKET_CAP = 50;

/** Shared page frame — one column, generous gutters, honest vertical rhythm. */
const FRAME = "mx-auto flex h-full max-w-[820px] flex-col px-6 py-8";

/**
 * The Worklist / Home surface (mockup Page 01, story F1). A calm cross-repo
 * "what needs me" home grouped by DERIVED honest state — Needs you / Running /
 * Waiting / Recent — never by hierarchy. Buckets come from a pure
 * `worklistBucket()` over `deriveBoardState`/`deriveAgentState`; live updates
 * ride the existing `phasr://task-status` stream via `useAllAgentLiveness`
 * (re-buckets rows in place) — no new subscription.
 */
export function WorklistView() {
  const query = useWorklist();

  if (query.isError) {
    return (
      <div className={FRAME}>
        <Header disabled />
        <PanelState
          kind="error"
          title="Couldn't load your worklist"
          error={query.error}
          onRetry={() => void query.refetch()}
          className="my-auto"
        />
      </div>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <div className={FRAME}>
        <Header disabled />
        <PanelState kind="loading" rows={6} className="mt-2" />
      </div>
    );
  }

  return <WorklistLoaded worklist={query.data} />;
}

/** The page title — prominent, its own tier above the controls (calm states). */
function PageTitle() {
  return (
    <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-(--color-text-primary)">
      Home
    </h1>
  );
}

/**
 * The header for the working states: page title on the left, a constrained
 * search on the right, and the optional global "Halt autopilot" affordance.
 * Rendered in loading/error/loaded for layout stability.
 */
function Header({
  disabled,
  query,
  onQueryChange,
  trailing,
}: {
  disabled?: boolean;
  query?: string;
  onQueryChange?: (v: string) => void;
  /** Optional right-aligned control (the global "Halt autopilot" affordance). */
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <div className="mr-auto shrink-0">
        <PageTitle />
      </div>
      <div className="relative w-[280px] max-w-full">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-[14px] -translate-y-1/2 text-(--color-text-muted)"
          aria-hidden="true"
        />
        <GlassInput
          type="search"
          aria-label="Search tickets, workflows, repos"
          placeholder="Search…"
          disabled={disabled}
          value={query ?? ""}
          onChange={(e) => onQueryChange?.(e.target.value)}
          className="h-8 pl-9 text-[12.5px]"
          data-testid="worklist-search"
        />
      </div>
      {trailing}
    </div>
  );
}

function WorklistLoaded({ worklist }: { worklist: WorklistState }) {
  const navigate = useNavigate();
  const openAddRepositoryPicker = useUiStore((s) => s.openAddRepositoryPicker);
  const liveness = useAllAgentLiveness();

  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [epicFilter, setEpicFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Gate the shared 1 Hz clock on whether any row is actually live (mirrors
  // BoardView) — a fully-quiet worklist never ticks.
  const anyLive = worklistHasLiveRow(worklist, liveness);
  const now = useNow(anyLive);

  const allItems = useMemo(
    () => buildWorklistItems(worklist, liveness, now),
    [worklist, liveness, now],
  );

  // Epic filter chips: only epics inside the active repo (or all epics when
  // "All repos"), so the repo × epic filters can never disagree.
  const epics = useMemo(
    () =>
      worklist.boards
        .filter((b) => !repoFilter || b.parent.repositoryId === repoFilter)
        .map((b) => ({ id: b.parent.id, name: b.parent.name })),
    [worklist.boards, repoFilter],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allItems.filter((item) => {
      if (repoFilter && item.repositoryId !== repoFilter) return false;
      if (epicFilter && item.parentId !== epicFilter) return false;
      if (q && !item.haystack.includes(q)) return false;
      return true;
    });
  }, [allItems, repoFilter, epicFilter, search]);

  // Group filtered rows by bucket in render order; hide empty groups.
  const groups = useMemo(
    () =>
      WORKLIST_BUCKET_ORDER.map((bucket) => ({
        bucket,
        rows: filtered.filter((r) => r.bucket === bucket),
      })).filter((g) => g.rows.length > 0),
    [filtered],
  );

  // The flat, capped, VISIBLE row order — the single source of truth for both
  // rendering and keyboard nav (so nav never lands on a collapsed-overflow row).
  const visibleRows = useMemo(() => {
    const out: WorklistItem[] = [];
    for (const g of groups) {
      const cap = expanded.has(g.bucket) ? g.rows.length : BUCKET_CAP;
      out.push(...g.rows.slice(0, cap));
    }
    return out;
  }, [groups, expanded]);

  // Keep the roving selection valid as the visible set changes — default to the
  // first row WITHOUT stealing focus from the search box (focus only moves on an
  // explicit j/k press, tracked by `focusPendingRef`).
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !visibleRows.some((r) => r.id === selectedId)) {
      setSelectedId(visibleRows[0]!.id);
    }
  }, [visibleRows, selectedId]);

  const selectedRef = useRef<HTMLDivElement>(null);
  const focusPendingRef = useRef(false);
  useEffect(() => {
    if (focusPendingRef.current) {
      selectedRef.current?.focus();
      focusPendingRef.current = false;
    }
  }, [selectedId]);

  const openItem = (item: WorklistItem) => {
    // Subtask → its ticket detail; loose agent → its workspace. Both resolve to
    // the same detail route (a subtask id IS a workspace id, spec §D2).
    void navigate({
      to: "/repositories/$repositoryId/workspaces/$workspaceId",
      params: { repositoryId: item.repositoryId, workspaceId: item.id },
    });
  };

  const moveSelection = (delta: number) => {
    if (visibleRows.length === 0) return;
    const ids = visibleRows.map((r) => r.id);
    const cur = selectedId ? ids.indexOf(selectedId) : -1;
    const next = Math.min(
      ids.length - 1,
      Math.max(0, (cur === -1 ? 0 : cur) + delta),
    );
    focusPendingRef.current = true;
    setSelectedId(ids[next]!);
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // ⌘K is handled globally by the command palette; nav keys stay local.
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    }
  };

  // ── whole-surface states (first-run / all-quiet) ──────────────────────────
  if (allItems.length === 0) {
    return (
      <div className={FRAME}>
        <PageTitle />
        {/* A global halt can be live even with no current work — stay honest. */}
        <AutopilotHaltedBanner className="mt-5" />
        {/* Bias the calm empty toward optical center (~42vh) — dead-centering it
            in the tall flex track reads as sitting low with a gap above. */}
        <div className="flex flex-1 items-center justify-center pb-[24vh]">
          {worklist.repositories.length === 0 ? (
            <PanelState
              kind="empty"
              icon={<FolderGit2 />}
              title="Nothing here yet"
              description="Add a repository, then start a workflow or a quick task — your agents will show up here as they work."
              action={
                <GlassButton
                  variant="primary"
                  size="sm"
                  onClick={openAddRepositoryPicker}
                >
                  Add repository
                </GlassButton>
              }
            />
          ) : (
            <PanelState
              kind="empty"
              icon={<CheckCircle2 />}
              title="Nothing needs you right now"
              description="Every agent is quiet. When something wants your attention — a review, a wedged run — it'll surface here."
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={FRAME}>
      <Header
        query={search}
        onQueryChange={setSearch}
        // Only surface the global panic button when an epic actually has
        // autopilot ON — else it persistently implies autopilot is running (and
        // hands a rare, borderline-destructive action the primary top-right slot)
        // when nothing is driving. (product-designer review H2)
        trailing={
          worklist.boards.some((b) => b.parent.autopilotEnabled) ? (
            <HaltAutopilotButton />
          ) : undefined
        }
      />

      {/* Global halt is a persistent, honest banner while set (§5). */}
      <AutopilotHaltedBanner className="mb-4" />

      {/* Filter chips — repo (single-select) · epic (toggle). Neutral fills so
          the surface's single warm beacon stays the keyboard selection. */}
      <div className="mb-5 flex flex-wrap gap-1" data-testid="worklist-chips">
        <Chip
          active={repoFilter === null}
          onClick={() => {
            setRepoFilter(null);
            setEpicFilter(null);
          }}
        >
          All repos
        </Chip>
        {worklist.repositories.map((repo) => (
          <Chip
            key={repo.id}
            active={repoFilter === repo.id}
            onClick={() => {
              setRepoFilter((cur) => (cur === repo.id ? null : repo.id));
              setEpicFilter(null);
            }}
          >
            {repo.name}
          </Chip>
        ))}
        {epics.length > 0 ? (
          <span className="mx-1.5 h-4 w-px self-center bg-(--color-border-subtle)" />
        ) : null}
        {epics.map((epic) => (
          <Chip
            key={epic.id}
            active={epicFilter === epic.id}
            onClick={() =>
              setEpicFilter((cur) => (cur === epic.id ? null : epic.id))
            }
          >
            <span className="text-(--color-text-muted)">workflow</span>
            {epic.name}
          </Chip>
        ))}
      </div>

      {/* The grouped rows (scrollable) + the keyboard-nav listbox. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <PanelState
              kind="empty"
              icon={<Search />}
              title="No matching tickets"
              description="No ticket, workflow, or repo matches those filters. Clear the search or a chip to see everything."
            />
          </div>
        ) : (
          <div
            role="listbox"
            aria-label="Worklist"
            aria-activedescendant={
              selectedId ? `worklist-row-${selectedId}` : undefined
            }
            onKeyDown={onListKeyDown}
            className="flex flex-col gap-7 pb-2"
          >
            {groups.map((group) => {
              const cap = expanded.has(group.bucket)
                ? group.rows.length
                : BUCKET_CAP;
              const shown = group.rows.slice(0, cap);
              const hidden = group.rows.length - shown.length;
              return (
                <section
                  key={group.bucket}
                  data-testid={`worklist-group-${group.bucket}`}
                >
                  <div className="mb-2 flex items-center gap-2 px-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-(--color-text-muted)">
                      {WORKLIST_BUCKET_LABEL[group.bucket]}
                    </span>
                    <span className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-(--color-bg-hover) px-1.5 text-[10.5px] font-medium tabular-nums leading-none text-(--color-text-muted)">
                      {group.rows.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {shown.map((item) => (
                      <WorklistRow
                        key={item.id}
                        item={item}
                        selected={item.id === selectedId}
                        {...(item.id === selectedId
                          ? { rowRef: selectedRef }
                          : {})}
                        onOpen={() => openItem(item)}
                        onFocus={() => setSelectedId(item.id)}
                      />
                    ))}
                    {hidden > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            next.add(group.bucket);
                            return next;
                          })
                        }
                        className="mt-0.5 inline-flex min-h-8 items-center self-start rounded-(--radius-control) px-3 py-1 text-[11.5px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                      >
                        Show {hidden} more
                      </button>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* Keyboard hints (mockup Page 01 footer). */}
      <div className="mt-4 flex gap-4 border-t border-(--color-border-subtle) pt-3 text-[11px] text-(--color-text-muted)">
        <span className="inline-flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd>
          open
        </span>
        <span className="inline-flex items-center gap-1">
          {SHORTCUTS.togglePalette.display.map((seg, i) => (
            <Kbd key={i}>{seg}</Kbd>
          ))}
          commands
        </span>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // ≥32px min hit target (L4) via min-height, not a bulkier pill — the
        // small text stays centered in a comfortably tappable box.
        "inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-[12px]",
        "transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
        active
          ? "bg-(--color-bg-active) font-medium text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
      )}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] bg-(--color-bg-hover) px-1 text-[10.5px] font-semibold text-(--color-text-secondary)">
      {children}
    </kbd>
  );
}
