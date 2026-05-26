import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Play, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";

interface RunCommandPickerProps {
  repositoryId: string;
}

export function RunCommandPicker({ repositoryId }: RunCommandPickerProps) {
  const { data: runCommands } = useRunCommands(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const handlePick = (id: string) => {
    runPanel.openTab(id);
    setOpen(false);
  };

  const handleAddCommand = () => {
    setOpen(false);
    void navigate({
      to: "/repositories/$repositoryId/settings",
      params: { repositoryId },
    });
  };

  const empty = !runCommands || runCommands.length === 0;

  return (
    <div ref={containerRef} className="relative">
      <GlassButton
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title="Run a repository command"
      >
        <Play size={10} fill="currentColor" />
        Run
        <ChevronDown size={11} className="opacity-60" />
      </GlassButton>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 min-w-52 overflow-hidden glass-modal animate-[modal-in_180ms_var(--ease-glass)]">
          <ul className="p-1">
            {empty ? (
              <li>
                <button
                  type="button"
                  onClick={handleAddCommand}
                  className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] text-(--color-text-primary) transition-colors duration-100 hover:bg-(--color-bg-hover)"
                >
                  <Plus size={12} className="shrink-0 text-(--color-text-muted)" />
                  <span className="leading-none">Add run command…</span>
                </button>
              </li>
            ) : (
              runCommands.map((rc) => (
                <li key={rc.id}>
                  <button
                    type="button"
                    onClick={() => handlePick(rc.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] text-(--color-text-primary) transition-colors duration-100 hover:bg-(--color-bg-hover)"
                  >
                    <span className="truncate leading-none">{rc.name}</span>
                    <code className="truncate text-[11px] text-(--color-text-muted)">
                      {rc.command}
                    </code>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
