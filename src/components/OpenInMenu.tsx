import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, FolderOpen, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { tauri } from "@/lib/tauri";
import type { Launcher, LauncherKind } from "@/lib/types";

interface OpenInMenuProps {
  /** Worktree (or repo) path to launch each app against. */
  path: string;
}

const KIND_LABEL: Record<LauncherKind, string> = {
  editor: "Code editors",
  terminal: "Terminals",
  filemanager: "File manager",
};

const KIND_ORDER: LauncherKind[] = ["editor", "terminal", "filemanager"];

export function OpenInMenu({ path }: OpenInMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: launchers } = useQuery({
    queryKey: ["launchers"],
    queryFn: () => tauri.listLaunchers(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const grouped: Record<LauncherKind, Launcher[]> = {
    editor: [],
    terminal: [],
    filemanager: [],
  };
  for (const launcher of launchers ?? []) {
    grouped[launcher.kind].push(launcher);
  }

  const handleLaunch = async (id: string) => {
    setOpen(false);
    try {
      await tauri.launchApp(id, path);
    } catch (err) {
      console.error(`Failed to open via ${id}`, err);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <GlassButton
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title="Open this worktree in another app"
      >
        <ExternalLink size={12} />
        Open in
        <ChevronDown size={11} className="opacity-60" />
      </GlassButton>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 overflow-hidden glass-modal animate-[modal-in_180ms_var(--ease-glass)]">
          {launchers && launchers.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-(--color-text-muted)">
              No editors or terminals detected.
            </div>
          )}
          {KIND_ORDER.map((kind) => {
            const items = grouped[kind];
            if (items.length === 0) return null;
            return (
              <div
                key={kind}
                className="border-b border-(--glass-border-hairline) p-1 last:border-b-0"
              >
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-(--color-text-muted)">
                  {KIND_LABEL[kind]}
                </div>
                {items.map((launcher) => (
                  <button
                    key={launcher.id}
                    type="button"
                    onClick={() => handleLaunch(launcher.id)}
                    className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] text-(--color-text-primary) transition-colors duration-100 hover:bg-[color-mix(in_oklab,white_6%,transparent)]"
                  >
                    <KindIcon kind={launcher.kind} />
                    <span className="leading-none">{launcher.name}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: LauncherKind }) {
  if (kind === "editor") return <ExternalLink size={12} />;
  if (kind === "terminal") return <TerminalSquare size={12} />;
  return <FolderOpen size={12} />;
}
