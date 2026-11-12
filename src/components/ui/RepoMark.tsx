import { repoColor, repoInitial } from "@/lib/repoColor";
import { cn } from "@/lib/utils";

/** Coloured repository square with its initial (A title bar / sidebar). */
export function RepoMark({
  id,
  name,
  size = 14,
  className,
}: {
  id: string;
  name: string;
  size?: 12 | 14 | 16;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center font-semibold leading-none text-(--color-text-inverse)",
        size === 16 ? "rounded-(--radius-chip) text-[10px]" : "rounded-[3px] text-[9px]",
        className,
      )}
      style={{ width: size, height: size, background: repoColor(id) }}
    >
      {size === 12 ? null : repoInitial(name)}
    </span>
  );
}
