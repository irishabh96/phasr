import * as RadixDialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Kbd } from "@/components/ui/Kbd";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  AccountSection,
  AgentsSection,
  AppearanceSection,
  KeyboardSection,
  NotificationsSection,
  TerminalSection,
} from "./AppSections";
import { RunCommandsSettings } from "./RepoSections";
import { BranchRulesSettings, WorktreesSettings } from "./RepoRules";
import { SETTINGS_SECTIONS, searchSettings, sectionMeta, type SettingsSectionId } from "./sections";
import { useSettingsRoute } from "./useSettingsRoute";

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

/**
 * Settings as a sheet over any screen (A-Settings): 880×600, section nav on
 * the left, one section on the right, changes save instantly. Opened by
 * `?settings=<section>` so the route underneath — and its live terminals —
 * never unmounts.
 */
export function SettingsSheet() {
  const { section, repositoryId: repoParam, row, open, close } = useSettingsRoute();
  const isOpen = section !== null;
  const { data: repositories } = useRepositories();
  const activeRepoId = useUiStore((s) => s.activeWorkspaceContext?.repositoryId ?? null);
  const repositoryId = repoParam ?? activeRepoId ?? repositories?.[0]?.id ?? null;
  const repository = repositories?.find((r) => r.id === repositoryId) ?? null;
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  // Deep link: scroll the requested row into view and flash it once.
  useEffect(() => {
    if (!isOpen || !row) return;
    const t = window.setTimeout(() => {
      const el = contentRef.current?.querySelector<HTMLElement>(`#settings-row-${CSS.escape(row)}`);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.dataset.flash = "true";
      window.setTimeout(() => delete el.dataset.flash, 900);
    }, 60);
    return () => window.clearTimeout(t);
  }, [isOpen, section, row]);

  useEffect(() => {
    if (!isOpen) setQuery("");
  }, [isOpen]);

  const hits = useMemo(() => searchSettings(query), [query]);
  const visible = new Set(hits.map((h) => h.section.id));
  const appSections = SETTINGS_SECTIONS.filter((s) => s.scope === "app" && visible.has(s.id));
  const repoSections = SETTINGS_SECTIONS.filter((s) => s.scope === "repo" && visible.has(s.id));

  const go = (id: SettingsSectionId, rowId?: string) =>
    open(id, { ...(repoParam ? { repositoryId: repoParam } : {}), ...(rowId ? { row: rowId } : {}) });

  const meta = section ? sectionMeta(section) : null;

  return (
    <RadixDialog.Root open={isOpen} onOpenChange={(o) => !o && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-(--z-overlay) bg-(--color-bg-overlay) data-[state=open]:animate-[overlay-in_160ms_var(--ease-glass)]" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="glass-modal fixed left-1/2 top-1/2 z-(--z-modal) flex h-[min(600px,calc(100vh-48px))] w-[min(880px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden outline-none data-[state=open]:animate-[modal-in_160ms_var(--ease-glass)]"
        >
          <nav
            aria-label="Settings sections"
            className="flex w-[208px] shrink-0 flex-col gap-0.5 border-r border-(--color-border-subtle) bg-(--color-bg-sidebar) px-2.5 py-3.5"
          >
            <RadixDialog.Title className="m-0 px-2 pb-2.5 pt-1 text-[13px] font-semibold">Settings</RadixDialog.Title>
            <label className="mb-2 flex h-7 items-center gap-1.5 rounded-(--radius-control) border border-(--color-border-default) bg-(--color-bg-base) px-2 text-(--color-text-muted) focus-within:border-(--color-focus-ring)">
              <Search className="size-3 shrink-0" aria-hidden />
              <input
                aria-label="Search settings"
                placeholder="Search settings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full border-0 bg-transparent p-0 text-[12px] text-(--color-text-primary) shadow-none outline-none focus:shadow-none"
              />
            </label>
            {appSections.map((s) => (
              <NavItem key={s.id} active={section === s.id} onClick={() => go(s.id)}>
                {s.label}
              </NavItem>
            ))}
            {query
              ? hits
                  .flatMap((h) => h.rows.map((r) => ({ section: h.section, row: r })))
                  .slice(0, 6)
                  .map(({ section: s, row: r }) => (
                    <button
                      key={`${s.id}:${r.id}`}
                      type="button"
                      onClick={() => go(s.id, r.id)}
                      className="truncate rounded-(--radius-control) px-2 py-1 text-left text-[11px] text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)"
                    >
                      {s.label} › {r.label}
                    </button>
                  ))
              : null}
            {repoSections.length > 0 ? (
              <>
                <div className="my-2 h-px bg-(--color-border-subtle)" />
                <RepoPicker
                  repositoryId={repositoryId}
                  onPick={(id) => open(section ?? "worktrees", { repositoryId: id })}
                />
                {repoSections.map((s) => (
                  <NavItem
                    key={s.id}
                    active={section === s.id}
                    onClick={() => open(s.id, repositoryId ? { repositoryId } : {})}
                  >
                    {s.label}
                  </NavItem>
                ))}
              </>
            ) : null}
            <div className="flex-1" />
            {APP_VERSION ? (
              <span className="px-2 font-mono text-[11px] text-(--color-text-faint)">Phasr {APP_VERSION}</span>
            ) : null}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-(--color-border-subtle) px-5">
              <h2 className="m-0 text-[13px] font-semibold">{meta?.label}</h2>
              {meta?.scope === "repo" && repository ? (
                <span className="text-[12px] text-(--color-text-muted)">repository · {repository.name}</span>
              ) : null}
              <RadixDialog.Close
                aria-label="Close settings"
                className="ml-auto grid size-[26px] place-items-center rounded-(--radius-control) text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
              >
                <X className="size-3.5" aria-hidden />
              </RadixDialog.Close>
            </header>
            <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto p-5">
              {section === "account" && <AccountSection />}
              {section === "appearance" && <AppearanceSection />}
              {section === "terminal" && <TerminalSection />}
              {section === "agents" && <AgentsSection />}
              {section === "run-commands" && <RunCommandsSettings repositoryId={repositoryId} />}
              {section === "keyboard" && <KeyboardSection />}
              {section === "notifications" && <NotificationsSection />}
              {section === "worktrees" && <WorktreesSettings repositoryId={repositoryId} />}
              {section === "branch-rules" && <BranchRulesSettings repositoryId={repositoryId} />}
            </div>
            <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-(--color-border-subtle) bg-(--color-bg-sidebar) px-5 text-[11px] text-(--color-text-muted)">
              <span aria-hidden className="size-1.5 rounded-full bg-(--color-success)" />
              Changes save instantly
              <span className="flex-1" />
              <Kbd>esc</Kbd> close
            </footer>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function NavItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-[30px] items-center rounded-(--radius-control) px-2 text-left text-[13px] transition-colors duration-100",
        "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
        active
          ? "bg-(--color-bg-elevated) font-medium text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
      )}
    >
      {children}
    </button>
  );
}

function RepoPicker({ repositoryId, onPick }: { repositoryId: string | null; onPick: (id: string) => void }) {
  const { data: repositories } = useRepositories();
  const current = repositories?.find((r) => r.id === repositoryId);
  if (!repositories || repositories.length === 0) {
    return <span className="group-header px-2 py-1">Repository</span>;
  }
  if (repositories.length === 1) {
    return <span className="group-header truncate px-2 py-1">Repository · {current?.name}</span>;
  }
  return (
    <label className="flex items-center gap-1 px-2 py-1">
      <span className="group-header shrink-0">Repository ·</span>
      <select
        aria-label="Repository"
        value={repositoryId ?? ""}
        onChange={(e) => onPick(e.target.value)}
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-(--color-text-muted) shadow-none focus:shadow-none"
      >
        {repositories.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}
