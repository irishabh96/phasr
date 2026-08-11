import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { inputBaseClasses } from "@/components/ui/GlassInput";
import { useGitBranches } from "@/lib/hooks/useGit";
import { humanizeError } from "@/lib/humanizeError";
import { cn } from "@/lib/utils";

interface BaseBranchFieldProps {
  id?: string;
  /** Repo path fed to `useGitBranches`; null/undefined disables the query. */
  repoPath: string | null | undefined;
  /** Pinned to the top of the list under a "Default" group. */
  defaultBranch?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Base-branch combobox shared by NewTaskForm and CreateFirstWorkspacePane.
 *
 * The input IS the ref — anything typed submits as-is, so tags, SHAs and
 * `origin/*` refs (which `list_local_branches` can't see) stay reachable.
 * Focus opens a portalled list of local branches: the repo's default
 * branch pinned first, then branches, with `phasr/*` task branches
 * collapsed behind a count so they never bury `main`. Typing filters;
 * a query matching nothing offers "use as custom ref" explicitly.
 *
 * The list must render through a portal: NewTaskModal's card is
 * `overflow-hidden`, and this field sits at its bottom edge. That's also
 * why this is a hand-rolled listbox rather than cmdk — cmdk drives
 * keyboard selection by querying the DOM inside its root, which the
 * portal escapes.
 */
export function BaseBranchField({
  id,
  repoPath,
  defaultBranch,
  value,
  onChange,
  disabled,
  placeholder,
  className,
}: BaseBranchFieldProps) {
  const branchesQuery = useGitBranches(repoPath);
  const branches = useMemo(
    () => branchesQuery.data ?? [],
    [branchesQuery.data],
  );

  const [open, setOpen] = useState(false);
  // When the field sits inside a modal Radix Dialog, a body-portalled
  // popover is pointer-dead: the dialog sets pointer-events:none on the
  // body and its scroll lock swallows wheel events outside its subtree.
  // Portal into the dialog's own content element instead (still outside
  // the overflow-hidden card, so nothing clips).
  const [portalContainer, setPortalContainer] = useState<
    HTMLElement | undefined
  >(undefined);
  // While true, the list filters on the input value (the user has typed
  // since opening). A fresh open shows the full list even though the
  // field already holds a ref.
  const [queryMode, setQueryMode] = useState(false);
  const [phasrExpanded, setPhasrExpanded] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  // Once the user moves the cursor themselves, the open-sync effect must
  // stop snapping it back to the current value on every rows change.
  const interactedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const listboxId = `${id ?? reactId}-listbox`;
  const optionId = (index: number) => `${id ?? reactId}-option-${index}`;

  const trimmedValue = value.trim();
  const query = queryMode ? trimmedValue.toLowerCase() : "";

  type Row =
    | { kind: "heading"; label: string }
    | { kind: "branch"; name: string; isDefault: boolean }
    | { kind: "custom"; ref: string }
    | { kind: "expand"; count: number }
    | { kind: "status"; tone: "muted" | "danger"; text: string; hint?: string };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (!repoPath) {
      out.push({
        kind: "status",
        tone: "muted",
        text: "Connect a git repo to list branches.",
      });
      return out;
    }
    if (branchesQuery.isPending) {
      out.push({ kind: "status", tone: "muted", text: "Loading branches…" });
      return out;
    }
    if (branchesQuery.isError) {
      out.push({
        kind: "status",
        tone: "danger",
        text: humanizeError(branchesQuery.error),
        hint: "Type a branch name instead.",
      });
      return out;
    }
    if (branches.length === 0) {
      out.push({
        kind: "status",
        tone: "muted",
        text: "No branches yet — this repo has no commits.",
      });
      return out;
    }

    const matches = (b: string) => b.toLowerCase().includes(query);
    const hasDefault =
      !!defaultBranch && branches.includes(defaultBranch) && matches(defaultBranch);
    const rest = branches.filter((b) => b !== defaultBranch);
    const normal = rest.filter((b) => !b.startsWith("phasr/") && matches(b));
    const phasrAll = rest.filter((b) => b.startsWith("phasr/"));
    const phasr = phasrAll.filter(matches);

    if (query && !hasDefault && normal.length === 0 && phasr.length === 0) {
      out.push({ kind: "custom", ref: trimmedValue });
      return out;
    }

    // The committed value isn't a local branch (tag, SHA, origin/*, or a
    // default branch that was never checked out locally) — surface it as
    // an explicit custom-ref row instead of pretending it isn't set.
    if (!queryMode && trimmedValue && !branches.includes(trimmedValue)) {
      out.push({ kind: "custom", ref: trimmedValue });
    }
    if (hasDefault && defaultBranch) {
      out.push({ kind: "heading", label: "Default" });
      out.push({ kind: "branch", name: defaultBranch, isDefault: true });
    }
    if (normal.length > 0) {
      out.push({ kind: "heading", label: "Branches" });
      for (const name of normal) out.push({ kind: "branch", name, isDefault: false });
    }
    if (query || phasrExpanded) {
      if (phasr.length > 0) {
        out.push({ kind: "heading", label: "Phasr task branches" });
        for (const name of phasr) out.push({ kind: "branch", name, isDefault: false });
      }
    } else if (phasrAll.length > 0) {
      out.push({ kind: "expand", count: phasrAll.length });
    }
    return out;
  }, [
    repoPath,
    branchesQuery.isPending,
    branchesQuery.isError,
    branchesQuery.error,
    branches,
    query,
    queryMode,
    trimmedValue,
    defaultBranch,
    phasrExpanded,
  ]);

  const isSelectable = (row: Row | undefined) =>
    !!row && (row.kind === "branch" || row.kind === "custom" || row.kind === "expand");

  const selectableIndexes = rows
    .map((row, i) => (isSelectable(row) ? i : -1))
    .filter((i) => i >= 0);

  const step = (from: number | null, dir: 1 | -1): number | null => {
    if (selectableIndexes.length === 0) return null;
    if (from === null)
      return (
        (dir === 1
          ? selectableIndexes[0]
          : selectableIndexes[selectableIndexes.length - 1]) ?? null
      );
    const pos = selectableIndexes.indexOf(from);
    const next =
      (pos + dir + selectableIndexes.length) % selectableIndexes.length;
    return selectableIndexes[next] ?? null;
  };

  const close = () => {
    setOpen(false);
    setQueryMode(false);
    setPhasrExpanded(false);
  };

  const openList = () => {
    if (disabled || open) return;
    setPortalContainer(
      (containerRef.current?.closest('[role="dialog"]') as HTMLElement | null) ??
        undefined,
    );
    setQueryMode(false);
    setPhasrExpanded(false);
    navSourceRef.current = "keyboard";
    setOpen(true);
  };

  // Force-close when the field becomes disabled (e.g. mid-submit).
  useEffect(() => {
    if (disabled && open) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  // Escape must close the list — and ONLY the list — no matter which layer
  // sees the key first. Radix's own escape handling lives in a document
  // capture listener registered in an effect, so a press landing between
  // paint and that effect (seen under e2e load) reaches neither Radix nor
  // the input's bubble handler in time. This capture listener registers
  // after the dialog's (mounted earlier), so the dialog's combobox guard
  // still runs first and keeps the modal open; stopPropagation here stops
  // later listeners from double-handling a list that is already closing.
  useEffect(() => {
    if (!open) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onDocKeyDown, { capture: true });
    return () =>
      document.removeEventListener("keydown", onDocKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // On open (and while branches stream in), park the cursor on the row
  // matching the current value — until the user navigates or types.
  useEffect(() => {
    if (!open) {
      setActive(null);
      interactedRef.current = false;
      return;
    }
    if (interactedRef.current) return;
    if (queryMode) {
      // Filtering: cursor snaps to the first match on every keystroke.
      setActive(selectableIndexes[0] ?? null);
      return;
    }
    const idx = rows.findIndex(
      (r) =>
        (r.kind === "branch" && r.name === trimmedValue) ||
        (r.kind === "custom" && r.ref === trimmedValue),
    );
    setActive(idx >= 0 ? idx : null);
    // selectableIndexes derives from rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, queryMode, trimmedValue]);

  // Keep the cursor row in view as it moves — but only for keyboard
  // moves. Scrolling under a resting pointer re-fires mousemove on a new
  // row, which would scroll again: a feedback loop.
  const navSourceRef = useRef<"keyboard" | "pointer">("keyboard");
  useEffect(() => {
    if (active === null || navSourceRef.current === "pointer") return;
    const el = document.getElementById(optionId(active));
    el?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const commit = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "branch") {
      onChange(row.name);
      close();
    } else if (row.kind === "custom") {
      onChange(row.ref);
      close();
    } else if (row.kind === "expand") {
      // The expand row is replaced by a heading, so the first task branch
      // lands at index + 1.
      interactedRef.current = true;
      setPhasrExpanded(true);
      setActive(index + 1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      interactedRef.current = true;
      navSourceRef.current = "keyboard";
      setActive(step(active, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    // Home/End jump rows only once the cursor is in the list; before
    // that they keep their native caret behaviour in the input.
    if (
      (e.key === "Home" || e.key === "End") &&
      open &&
      interactedRef.current &&
      active !== null
    ) {
      e.preventDefault();
      interactedRef.current = true;
      navSourceRef.current = "keyboard";
      setActive(
        e.key === "Home"
          ? (selectableIndexes[0] ?? null)
          : (selectableIndexes[selectableIndexes.length - 1] ?? null),
      );
      return;
    }
    if (e.key === "Enter") {
      if (!open) return; // closed → implicit form submit stays intact
      // stopPropagation as well: the form's ⌘↵ handler would otherwise
      // fire submit() with the value from BEFORE this commit flushed —
      // committing one branch and submitting another.
      e.preventDefault();
      e.stopPropagation();
      if (active !== null && isSelectable(rows[active])) commit(active);
      else close();
      return;
    }
    if (e.key === "Escape") {
      if (!open) return;
      // Close the list only — must not bubble up and close the modal.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") close();
  };

  const activeRowClasses =
    "bg-[color-mix(in_oklab,var(--color-accent-500)_20%,transparent)] font-medium before:absolute before:bottom-1 before:left-0 before:top-1 before:w-[2px] before:rounded-full before:bg-(--color-focus-ring)";
  const rowBaseClasses =
    "relative flex cursor-pointer items-center gap-2 rounded-[8px] px-2.5";

  // Status rows are always exclusive (the builder early-returns), and
  // they live OUTSIDE the listbox as a live region — an aria-hidden or
  // option-shaped "Loading…" would leave AT users with a silent list.
  const firstRow = rows[0];
  const statusRow = firstRow?.kind === "status" ? firstRow : null;

  const rowInteractionProps = (index: number) => ({
    // preventDefault keeps focus in the input — that's what makes this a
    // combobox rather than a menu.
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onMouseMove: () => {
      if (active !== index) {
        interactedRef.current = true;
        navSourceRef.current = "pointer";
        setActive(index);
      }
    },
    onClick: () => commit(index),
  });

  return (
    <Popover.Root open={open} onOpenChange={(o) => (o ? openList() : close())}>
      <Popover.Anchor asChild>
        <div ref={containerRef} className="relative">
          <input
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              open && active !== null ? optionId(active) : undefined
            }
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => {
              onChange(e.target.value);
              setQueryMode(true);
              interactedRef.current = false;
              if (!open && !disabled) setOpen(true);
            }}
            onFocus={openList}
            onClick={openList}
            onKeyDown={handleKeyDown}
            className={cn(
              inputBaseClasses,
              "h-9 pl-3 pr-9 font-mono text-[13px]",
              className,
            )}
          />
          <ChevronDown
            size={14}
            aria-hidden
            className={cn(
              "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-(--color-text-muted)",
              "transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              open && "rotate-180",
            )}
          />
        </div>
      </Popover.Anchor>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // Clicks on the input itself are "outside" the portal — they
            // must not close-then-reopen the list.
            if (containerRef.current?.contains(e.target as Node))
              e.preventDefault();
          }}
          className={cn(
            "pointer-events-auto z-(--z-popover) w-(--radix-popover-trigger-width)",
            "max-h-[min(280px,var(--radix-popover-content-available-height,280px))] overflow-y-auto overscroll-contain",
            "rounded-[var(--radius-panel)] border border-(--color-border-default) bg-(--color-bg-elevated) p-1",
            "animate-[modal-in_180ms_var(--ease-glass)]",
          )}
        >
          {statusRow && (
            <div role="status" aria-live="polite" className="px-2.5 py-2">
              <span
                className={cn(
                  "block text-[12px]",
                  statusRow.tone === "danger"
                    ? "text-(--color-danger-text)"
                    : "text-(--color-text-muted)",
                )}
              >
                {statusRow.text}
              </span>
              {statusRow.hint && (
                <span className="block pt-0.5 text-[11px] text-(--color-text-muted)">
                  {statusRow.hint}
                </span>
              )}
            </div>
          )}
          {/* mousedown-preventDefault lives here, NOT on the scrollable
              Content — on the Content it would also cancel native
              scrollbar drags. Headings and gaps still keep input focus. */}
          <div
            role="listbox"
            id={listboxId}
            aria-label="Base branch"
            onMouseDown={(e) => e.preventDefault()}
          >
            {rows.map((row, index) => {
              if (row.kind === "status") return null;
              if (row.kind === "heading") {
                return (
                  <div
                    key={`heading-${row.label}`}
                    role="presentation"
                    className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)"
                  >
                    {row.label}
                  </div>
                );
              }
              if (row.kind === "expand") {
                return (
                  <div
                    key="expand"
                    id={optionId(index)}
                    role="option"
                    aria-selected={false}
                    aria-label={`Show ${row.count} phasr task branches`}
                    {...rowInteractionProps(index)}
                    className={cn(
                      rowBaseClasses,
                      "h-8 text-[12.5px] text-(--color-text-secondary)",
                      active === index && activeRowClasses,
                    )}
                  >
                    <span className="w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      Phasr task branches
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[10.5px]",
                        // muted fails 4.5:1 on the accent-tinted active fill
                        // in dark — promote to secondary while highlighted
                        active === index
                          ? "text-(--color-text-secondary)"
                          : "text-(--color-text-muted)",
                      )}
                    >
                      {row.count}
                    </span>
                  </div>
                );
              }
              if (row.kind === "custom") {
                const isCurrent = row.ref === trimmedValue;
                return (
                  <div
                    key="custom"
                    id={optionId(index)}
                    role="option"
                    aria-selected={isCurrent}
                    {...rowInteractionProps(index)}
                    className={cn(
                      rowBaseClasses,
                      "items-start py-1.5",
                      active === index && activeRowClasses,
                    )}
                  >
                    <span className="flex w-4 shrink-0 justify-center pt-0.5">
                      {isCurrent && (
                        <Check
                          size={13}
                          aria-hidden
                          className="text-(--color-accent-text)"
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-(--color-text-primary)">
                        Use{" "}
                        <span className="font-mono">
                          &quot;{row.ref}&quot;
                        </span>{" "}
                        as a custom ref
                      </span>
                      <span
                        className={cn(
                          "block text-[11px]",
                          active === index
                            ? "text-(--color-text-secondary)"
                            : "text-(--color-text-muted)",
                        )}
                      >
                        Tag, SHA or origin/… — phasr can&apos;t verify this
                      </span>
                    </span>
                  </div>
                );
              }
              const isCurrent = row.name === trimmedValue;
              return (
                <div
                  key={row.name}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isCurrent}
                  {...rowInteractionProps(index)}
                  className={cn(
                    rowBaseClasses,
                    "h-8 font-mono text-[12.5px] text-(--color-text-primary)",
                    active === index && activeRowClasses,
                  )}
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    {isCurrent && (
                      <Check
                        size={13}
                        aria-hidden
                        className="text-(--color-accent-text)"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={row.name}>
                    {row.name}
                  </span>
                  {row.isDefault && (
                    <span
                      className={cn(
                        "shrink-0 font-sans text-[10.5px] uppercase tracking-[0.08em]",
                        active === index
                          ? "text-(--color-text-secondary)"
                          : "text-(--color-text-muted)",
                      )}
                    >
                      default
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
