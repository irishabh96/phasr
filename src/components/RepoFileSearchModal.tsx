import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { File, Search } from "lucide-react";
import { useRepoFiles } from "@/lib/hooks/useRepoFiles";
import { useUiStore } from "@/lib/store";

/**
 * Repo-scoped file picker. Opened via `useUiStore.openFileSearch(repoId, path)`.
 * On select: opens an in-app preview tab on that repo via the tab system.
 */
export function RepoFileSearchModal() {
  const target = useUiStore((s) => s.fileSearchTarget);
  const close = useUiStore((s) => s.closeFileSearch);
  const openPreviewTab = useUiStore((s) => s.openPreviewTab);
  const open = target !== null;
  const { data: files, isLoading } = useRepoFiles(target?.path ?? null);

  const onSelect = (relative: string) => {
    if (!target) return;
    openPreviewTab(target.repositoryId, relative);
    close();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/30 backdrop-blur-md data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)]" />
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-[210] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] overflow-hidden">
            <Command label="Search files" shouldFilter>
              <Dialog.Title asChild>
                <span className="sr-only">Search files</span>
              </Dialog.Title>
              <div className="flex items-center gap-2 border-b border-(--glass-border-hairline) px-3">
                <Search size={13} className="text-(--color-text-muted)" />
                <Command.Input
                  autoFocus
                  placeholder={
                    isLoading ? "Indexing files…" : `Search ${files?.length ?? 0} files`
                  }
                  className="h-12 w-full border-0 bg-transparent text-[13.5px] focus:outline-none"
                />
                <kbd className="rounded-[5px] border border-(--glass-border-hairline) bg-[color-mix(in_oklab,white_4%,transparent)] px-1.5 py-0.5 text-[10px] text-(--color-text-muted)">
                  esc
                </kbd>
              </div>
              <Command.List className="max-h-[60vh] overflow-y-auto p-2">
                {isLoading && (
                  <div className="px-3 py-4 text-center text-[12px] text-(--color-text-muted)">
                    Loading files…
                  </div>
                )}
                <Command.Empty className="px-3 py-6 text-center text-[12px] text-(--color-text-muted)">
                  No files match.
                </Command.Empty>
                {files?.map((relative) => (
                  <Command.Item
                    key={relative}
                    value={relative}
                    onSelect={() => onSelect(relative)}
                    className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12.5px] text-(--color-text-secondary) transition-colors duration-100 aria-selected:bg-[color-mix(in_oklab,var(--color-accent-500)_12%,transparent)] aria-selected:text-(--color-text-primary)"
                  >
                    <File size={13} className="shrink-0 text-(--color-text-muted)" />
                    <span className="min-w-0 flex-1 truncate">{relative}</span>
                  </Command.Item>
                ))}
              </Command.List>
            </Command>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
