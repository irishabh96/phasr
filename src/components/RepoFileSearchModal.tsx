import { Command } from "cmdk";
import { ChevronRight, File, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ITEM_CLS,
  PALETTE_DIALOG_CLS,
  PALETTE_INPUT_CLS,
  PALETTE_LIST_CLS,
  PALETTE_SHELL_CLS,
} from "@/components/ui/palette";
import {
  PaletteFooter,
  PaletteGroup,
} from "@/components/ui/PaletteParts";
import { useRepoFiles } from "@/lib/hooks/useRepoFiles";
import { useRepositories } from "@/lib/hooks/useRepositories";
import { useUiStore } from "@/lib/store";

/**
 * File picker. Opened via `useUiStore.openFileSearch(repoId, path)` — for
 * example by the ⌘P hotkey when a workspace tab is active, or by the
 * empty-repo screen's Search Files action.
 *
 * On select:
 *   - With an active workspace → opens a file-preview inner tab in it.
 *   - Otherwise → opens a preview tab on the repo's inner tab bar
 *     (`openRepoInnerPreviewTab`), driving the empty-repo view.
 *
 * Styling is shared with `CommandPalette` via `@/components/ui/palette`.
 */
export function RepoFileSearchModal() {
  const target = useUiStore((s) => s.fileSearchTarget);
  const close = useUiStore((s) => s.closeFileSearch);
  const openInnerPreviewTab = useUiStore((s) => s.openInnerPreviewTab);
  const openRepoInnerPreviewTab = useUiStore((s) => s.openRepoInnerPreviewTab);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceContext?.workspaceId ?? null);
  const { data: repositories } = useRepositories();
  const open = target !== null;
  const [query, setQuery] = useState("");
  const { data: files, isLoading } = useRepoFiles(target?.path ?? null);

  const repoName = useMemo(() => {
    if (!target) return null;
    return repositories?.find((r) => r.id === target.repositoryId)?.name ?? null;
  }, [target, repositories]);

  const onSelect = (relative: string) => {
    if (!target) {
      close();
      return;
    }
    if (activeWorkspaceId) {
      openInnerPreviewTab(activeWorkspaceId, relative);
    } else {
      openRepoInnerPreviewTab(target.repositoryId, relative);
    }
    close();
    setQuery("");
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          close();
          setQuery("");
        }
      }}
      label="Search files"
      className={PALETTE_DIALOG_CLS}
      shouldFilter
    >
      <div className="relative w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className={PALETTE_SHELL_CLS}>
          <div className="flex items-center gap-3 px-5 pt-5 pb-2">
            <Search size={18} className="shrink-0 text-(--color-text-muted)" />
            {repoName && (
              <span className="flex shrink-0 items-center gap-1 text-[13px] text-(--color-text-secondary)">
                <span className="truncate font-medium">{repoName}</span>
                <ChevronRight size={13} className="text-(--color-text-muted)" />
              </span>
            )}
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={
                isLoading ? "Indexing files…" : `Search ${files?.length ?? 0} files`
              }
              className={PALETTE_INPUT_CLS}
            />
          </div>

          <Command.List className={PALETTE_LIST_CLS}>
            {isLoading && (
              <div className="px-3 py-6 text-center text-[12px] text-(--color-text-muted)">
                Loading files…
              </div>
            )}
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-(--color-text-muted)">
              No files match.
            </Command.Empty>

            {files && files.length > 0 && (
              <PaletteGroup heading="Files">
                {files.map((relative) => (
                  <Command.Item
                    key={relative}
                    value={relative}
                    onSelect={() => onSelect(relative)}
                    className={ITEM_CLS}
                  >
                    <File size={15} className="shrink-0 text-(--color-text-secondary)" />
                    <span className="min-w-0 flex-1 truncate text-[15px]">{relative}</span>
                  </Command.Item>
                ))}
              </PaletteGroup>
            )}
          </Command.List>

          <PaletteFooter />
        </div>
      </div>
    </Command.Dialog>
  );
}
