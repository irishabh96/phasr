import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type AppToast,
  type ToastIntent,
} from "@/lib/toast";
import { cn } from "@/lib/utils";

const EXIT_MS = 140;

const INTENT: Record<ToastIntent, { Icon: LucideIcon; color: string }> = {
  success: { Icon: CircleCheck, color: "text-(--color-success)" },
  error: { Icon: CircleAlert, color: "text-(--color-danger)" },
  warning: { Icon: TriangleAlert, color: "text-(--color-warning)" },
  info: { Icon: Info, color: "text-(--color-info)" },
};

type RenderItem = { toast: AppToast; leaving: boolean };

/**
 * Notification stack. The viewport is a single, ALWAYS-mounted live region
 * (fixes SR dropping announcements when the list is empty). Each card is on the
 * glass material with a leading intent icon; enter/exit animate (opacity-only
 * under reduced motion). Timers pause while the pointer/focus is inside.
 */
export function AppToaster() {
  const storeToasts = useToasts();
  const [items, setItems] = useState<RenderItem[]>([]);
  const exitTimers = useRef<Map<string, number>>(new Map());

  // Presence: keep a card mounted for one exit animation after it leaves the
  // store (whether dismissed by hand or by its auto-dismiss timer).
  useEffect(() => {
    setItems((prev) => {
      const storeById = new Map(storeToasts.map((t) => [t.id, t]));
      const prevIds = new Set(prev.map((it) => it.toast.id));

      const additions: RenderItem[] = storeToasts
        .filter((t) => !prevIds.has(t.id))
        .map((t) => ({ toast: t, leaving: false }));

      const kept: RenderItem[] = prev.map((it) => {
        const still = storeById.get(it.toast.id);
        if (still) return { toast: still, leaving: false };
        if (!it.leaving && !exitTimers.current.has(it.toast.id)) {
          const id = it.toast.id;
          const handle = window.setTimeout(() => {
            exitTimers.current.delete(id);
            setItems((cur) => cur.filter((x) => x.toast.id !== id));
          }, EXIT_MS);
          exitTimers.current.set(id, handle);
        }
        return { toast: it.toast, leaving: true };
      });

      return [...additions, ...kept];
    });
  }, [storeToasts]);

  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      for (const handle of timers.values()) window.clearTimeout(handle);
      timers.clear();
    };
  }, []);

  return (
    <ol
      role="region"
      aria-label="Notifications"
      tabIndex={-1}
      className="pointer-events-none fixed right-4 top-4 z-(--z-toast) flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {items.map(({ toast, leaving }) => (
        <ToastCard key={toast.id} toast={toast} leaving={leaving} />
      ))}
    </ol>
  );
}

function ToastCard({ toast, leaving }: { toast: AppToast; leaving: boolean }) {
  const { Icon, color } = INTENT[toast.intent];
  const isError = toast.intent === "error";

  return (
    <li
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      data-leaving={leaving ? "" : undefined}
      onPointerEnter={() => pauseToast(toast.id)}
      onPointerLeave={() => resumeToast(toast.id)}
      onFocus={() => pauseToast(toast.id)}
      onBlur={() => resumeToast(toast.id)}
      className={cn(
        "glass-panel pointer-events-auto p-3",
        "animate-[toast-in_180ms_var(--ease-glass)]",
        "data-[leaving]:animate-[toast-out_140ms_var(--ease-glass)]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn("mt-px size-4 shrink-0", color)}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-(--color-text-primary)">
            {toast.title}
          </div>
          {toast.message ? (
            <p className="mt-1 text-[13px] text-(--color-text-secondary)">
              {toast.message}
            </p>
          ) : null}
          {toast.code ? (
            <p className="mt-1.5 break-words font-mono text-[12px] text-(--color-text-muted)">
              {toast.code}
            </p>
          ) : null}
          {toast.action ? (
            <div className="mt-2.5">
              <GlassButton
                variant="outline"
                size="sm"
                onClick={() => {
                  const action = toast.action!;
                  // `url` variant opens the browser; the in-app variant
                  // (DDR-003 §5) runs a handler, e.g. router navigation.
                  if ("url" in action) void openUrl(action.url);
                  else action.onClick();
                  dismissToast(toast.id);
                }}
              >
                {toast.action.label}
              </GlassButton>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dismissToast(toast.id)}
          className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-[8px] text-(--color-text-muted) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
