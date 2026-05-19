import { ChevronDown, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";

interface RunCommandPickerProps {
  repositoryId: string;
}

/**
 * "Run ▾" dropdown that lists every run command defined for the
 * repository and opens the picked one in the docked terminal pane.
 * Designed to sit alongside <OpenInMenu> in any header that has
 * `repositoryId` in scope (repository view, workspace detail).
 */
export function RunCommandPicker({ repositoryId }: RunCommandPickerProps) {
  const { data: runCommands } = useRunCommands(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);

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

  if (!runCommands || runCommands.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Run a repository command"
        className="flex items-center gap-1 rounded-md border border-(--color-border-default) bg-(--color-bg-input) px-2.5 py-1 text-xs text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
      >
        <Play size={11} fill="currentColor" />
        Run
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-44 overflow-hidden rounded-md border border-(--color-border-default) bg-(--color-bg-elevated) shadow-lg">
          <ul className="py-1">
            {runCommands.map((rc) => (
              <li key={rc.id}>
                <button
                  type="button"
                  onClick={() => handlePick(rc.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-(--color-text-primary) hover:bg-(--color-bg-base)"
                >
                  <span className="truncate">{rc.name}</span>
                  <code className="truncate text-(--color-text-muted)">
                    {rc.command}
                  </code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
