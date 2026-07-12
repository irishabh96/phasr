import { CircleAlert } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { humanizeError } from "@/lib/humanizeError";
import { cn } from "@/lib/utils";

type PanelStateProps =
  | { kind: "loading"; rows?: number; className?: string }
  | {
      kind: "empty";
      /** Leading icon (e.g. `<FolderGit2 />`); rendered in a 40px circle. */
      icon?: React.ReactNode;
      title: string;
      description?: string;
      /** CTA slot — usually a `<GlassButton variant="primary" size="sm">`. */
      action?: React.ReactNode;
      className?: string;
    }
  | {
      kind: "error";
      title?: string;
      /** Explicit body copy; overrides the humanized error when provided. */
      description?: string;
      /** Raw error, rendered via humanizeError(); never shown raw. */
      error?: unknown;
      /** Retry handler → renders an outline "Retry" GlassButton. */
      onRetry?: () => void;
      className?: string;
    };

const CENTER =
  "mx-auto flex max-w-[320px] flex-col items-center py-10 text-center";

/**
 * One primitive for the three panel states the audit found dropped app-wide.
 * `loading` renders skeleton rows; `empty`/`error` render icon + headline +
 * support + a CTA slot. `error` gets role="alert" so nothing fails silently.
 */
export function PanelState(props: PanelStateProps) {
  if (props.kind === "loading") {
    const rows = props.rows ?? 3;
    return (
      <div
        className={cn("flex flex-col gap-2", props.className)}
        aria-hidden="true"
      >
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="skeleton-bar h-11 rounded-[10px] bg-(--color-bg-hover) animate-[pulse-skeleton_1.4s_ease-in-out_infinite]"
          />
        ))}
      </div>
    );
  }

  if (props.kind === "empty") {
    const { icon, title, description, action, className } = props;
    return (
      <div className={cn(CENTER, className)}>
        {icon ? (
          <div className="mb-3 grid size-10 place-items-center rounded-full bg-(--color-bg-hover) text-(--color-text-muted) [&_svg]:size-6">
            {icon}
          </div>
        ) : null}
        <h3 className="text-[14px] font-medium text-(--color-text-primary)">
          {title}
        </h3>
        {description ? (
          <p className="mt-1 text-[13px] text-(--color-text-secondary)">
            {description}
          </p>
        ) : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    );
  }

  const {
    title = "Something went wrong",
    description,
    error,
    onRetry,
    className,
  } = props;
  return (
    <div role="alert" className={cn(CENTER, className)}>
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-(--color-bg-hover) text-(--color-danger)">
        <CircleAlert className="size-6" aria-hidden="true" />
      </div>
      <h3 className="text-[14px] font-semibold text-(--color-danger)">
        {title}
      </h3>
      <p className="mt-1 text-[13px] text-(--color-text-secondary)">
        {description ?? humanizeError(error)}
      </p>
      {onRetry ? (
        <div className="mt-4">
          <GlassButton variant="outline" size="sm" onClick={onRetry}>
            Retry
          </GlassButton>
        </div>
      ) : null}
    </div>
  );
}
