import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FolderGit2, Search } from "lucide-react";
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
      <div className="mx-auto max-w-[860px] px-5 py-6">
        <Header disabled />
        <PanelState
          kind="error"
          title="Couldn't load your worklist"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <div className="mx-auto max-w-[860px] px-5 py-6">
        <Header disabled />
        <PanelState kind="loading" rows={6} className="mt-4" />
      </div>
    );
  }

  return <WorklistLoaded worklist={query.data} />;
}

/** The static header (title + search) — rendered in every state for stability. */
function Header({
  disabled,
  query,
  onQueryChange,
}: {
  disabled?: boolean;
  query?: string;
  onQueryChange?: (v: string) => void;
}) {
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
      <h1 className="shrink-0 text-[17px] font-semibold text-(--color-text-primary)">
        Home
      </h1>
      <div className="relative min-w-[180px] flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-[14px] -translate-y-1/2 text-(--color-text-muted)"
          aria-hidden="true"
        />
        <GlassInput
          type="search"
          aria-label="Search tickets, epics, repos"
          placeholder="Search tickets, epics, repos…"
          disabled={disabled}
          value={query ?? ""}
          onChange={(e) => onQueryChange?.(e.target.value)}
          className="h-8 pl-9 text-[12.5px]"
          data-testid="worklist-search"
        />
      </div>
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
      <div className="mx-auto max-w-[860px] px-5 py-6">
        <Header query={search} onQueryChange={setSearch} disabled />
        {worklist.repositories.length === 0 ? (
          <PanelState
            kind="empty"
            icon={<FolderGit2 />}
            title="Nothing here yet"
            description="Add a repository, then start an epic or a quick task — your agents will show up here as they work."
            action={
              <GlassButton
                variant="primary"
                size="sm"
                onClick={openAddRepositoryPicker}
              >
                Add repository
              </GlassButton>
            }
            className="mt-6"
          />
        ) : (
          <PanelState
            kind="empty"
            title="Nothing needs you right now"
            description="Every agent is quiet. When something wants your attention — a review, a wedged run — it'll surface here."
            className="mt-6"
          />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-[860px] flex-col px-5 py-6">
      <Header query={search} onQueryChange={setSearch} />

      {/* Filter chips — repo (single-select) · epic (toggle). */}
      <div className="mb-4 flex flex-wrap gap-1.5" data-testid="worklist-chips">
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
          <span className="mx-1 h-3.5 w-px self-center bg-(--color-border-subtle)" />
        ) : null}
        {epics.map((epic) => (
          <Chip
            key={epic.id}
            active={epicFilter === epic.id}
            onClick={() =>
              setEpicFilter((cur) => (cur === epic.id ? null : epic.id))
            }
          >
            epic: {epic.name}
          </Chip>
        ))}
      </div>

      {/* The grouped rows (scrollable) + the keyboard-nav listbox. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length === 0 ? (
          <PanelState
            kind="empty"
            title="No matching tickets"
            description="No ticket, epic, or repo matches those filters. Clear the search or a chip to see everything."
            className="mt-6"
          />
        ) : (
          <div
            role="listbox"
            aria-label="Worklist"
            aria-activedescendant={
              selectedId ? `worklist-row-${selectedId}` : undefined
            }
            onKeyDown={onListKeyDown}
            className="flex flex-col gap-4"
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
                  <div className="flex items-center gap-2 px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-(--color-text-muted)">
                    {WORKLIST_BUCKET_LABEL[group.bucket]}
                    <span className="text-(--color-text-secondary)">
                      {group.rows.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
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
                        className="self-start rounded-[8px] px-2 py-1 text-[11.5px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
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
      <div className="mt-3 flex gap-3.5 text-[11px] text-(--color-text-muted)">
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
        "inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px]",
        "transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
        active
          ? "border border-transparent bg-(--color-bg-selected) text-(--color-text-primary)"
          : "border border-(--color-border-default) text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
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
