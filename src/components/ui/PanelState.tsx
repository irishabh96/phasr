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
      /**
       * Optional raw reason tucked behind a "Details" disclosure — for surfaces
       * where the unedited backend text is genuinely useful to a developer
       * (e.g. a git `index.lock`). The heading/description stay humanized.
       */
      details?: string;
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
    details,
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
      {details ? (
        <details
          className="mt-3 w-full text-left text-[11.5px] text-(--color-text-muted)"
          data-testid="panel-error-details"
        >
          <summary className="cursor-pointer select-none rounded-[4px] text-center hover:text-(--color-text-primary) focus-visible:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none">
            Details
          </summary>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-[8px] border border-(--glass-border-hairline) bg-(--color-bg-input) p-2 font-mono text-[10.5px] text-(--color-text-secondary)">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
