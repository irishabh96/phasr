import { Command } from "cmdk";
import { File, Search } from "lucide-react";
import { useState } from "react";
import {
  ITEM_CLS,
  PALETTE_DIALOG_CLS,
  PALETTE_INPUT_CLS,
  PALETTE_INPUT_ROW_CLS,
  PALETTE_LIST_CLS,
  PALETTE_SHELL_CLS,
} from "@/components/ui/palette";
import {
  PaletteFooter,
  PaletteGroup,
} from "@/components/ui/PaletteParts";
import { useRepoFiles } from "@/lib/hooks/useRepoFiles";
import { useUiStore } from "@/lib/store";

/**
 * File picker. Opened via `useUiStore.openFileSearch(repoId, path)` — for
 * example by the ⌘P hotkey when a workspace tab is active, or by the
 * empty-repo state's action list.
 *
 * On select:
 *   - With an active workspace → opens a file-preview inner tab in it.
 *   - Otherwise (empty-repo context) → opens a repo-scoped overlay
 *     viewer via `openRepoFilePreview`. The overlay is mounted in
 *     `_app.tsx` as `<RepoFilePreviewOverlay>`.
 *
 * Styling is shared with `CommandPalette` via `@/components/ui/palette`.
 */
export function RepoFileSearchModal() {
  const target = useUiStore((s) => s.fileSearchTarget);
  const close = useUiStore((s) => s.closeFileSearch);
  const openInnerPreviewTab = useUiStore((s) => s.openInnerPreviewTab);
  const openRepoFilePreview = useUiStore((s) => s.openRepoFilePreview);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceContext?.workspaceId ?? null);
  const open = target !== null;
  const [query, setQuery] = useState("");
  const { data: files, isLoading } = useRepoFiles(target?.path ?? null);

  const onSelect = (relative: string) => {
    if (!target) {
      close();
      return;
    }
    if (activeWorkspaceId) {
      openInnerPreviewTab(activeWorkspaceId, relative);
    } else {
      openRepoFilePreview(target.path, relative);
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
          <div className={PALETTE_INPUT_ROW_CLS}>
            <Search size={18} className="shrink-0 text-(--color-text-muted)" />
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
