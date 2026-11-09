import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { humanizeError } from "@/lib/humanizeError";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";

const key = ["settings", "unconfirmed"] as const;

/**
 * Agent command templates and the terminal shell sync between devices, and
 * both are run. A value synced from another device is only used here after
 * you allow it on this Mac (until then the default template / login shell
 * runs). Hidden when there's nothing to confirm.
 */
export function SyncedSettingsBanner({ scope }: { scope: "agentCommands" | "terminalShell" }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: key, queryFn: () => tauri.listUnconfirmedSettings(), retry: false });
  const confirm = useMutation({
    mutationFn: () => tauri.confirmSettingsOnThisMachine(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (err) => showToast({ intent: "error", title: "Couldn't allow the settings", message: humanizeError(err) }),
  });
  const pending = (Array.isArray(data) ? data : []).filter((k) => k.startsWith(scope));
  if (pending.length === 0) return null;
  const what =
    scope === "terminalShell"
      ? "The terminal shell"
      : `Command templates for ${pending.map((k) => k.split(".")[1]).join(", ")}`;
  return (
    <div role="status" className="flex items-center gap-3 rounded-(--radius-card) border border-(--color-warning) bg-(--color-warning-tint) px-3.5 py-2.5 text-[12px]">
      <span className="flex-1 text-(--color-text-secondary)">
        {what} came from another device and aren&apos;t used here until you allow them. Until then the defaults run.
      </span>
      <Button size="sm" variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        Allow on this Mac
      </Button>
    </div>
  );
}
