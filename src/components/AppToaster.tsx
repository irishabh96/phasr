import { X } from "lucide-react";
import { dismissToast, useToasts, type AppToast } from "@/lib/toast";

function toastBorder(toast: AppToast) {
  if (toast.intent === "error") return "border-(--color-danger)";
  if (toast.intent === "success") return "border-(--color-success)";
  return "border-(--color-border-subtle)";
}

export function AppToaster() {
  const toasts = useToasts();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-4 top-4 z-[1000] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.intent === "error" ? "alert" : "status"}
          className={`rounded-md border bg-(--color-bg-input) p-3 text-sm text-(--color-text-primary) shadow-xl ${toastBorder(toast)}`}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{toast.title}</div>
              {toast.message ? (
                <p className="mt-1 text-(--color-text-secondary)">
                  {toast.message}
                </p>
              ) : null}
              {toast.code ? (
                <p className="mt-2 font-mono text-xs text-(--color-text-muted)">
                  {toast.code}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="rounded p-1 text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
              onClick={() => dismissToast(toast.id)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
