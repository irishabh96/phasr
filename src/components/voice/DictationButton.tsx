import * as Popover from "@radix-ui/react-popover";
import { Mic } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { useSettingsRoute } from "@/components/settings/useSettingsRoute";
import { SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import type { VoiceModel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/voice/prefs";
import type { Dictation } from "@/lib/voice/useDictation";
import { useDownloadVoiceModel, useVoiceModels } from "@/lib/voice/useVoiceModels";

const DICTATE = SHORTCUTS.dictate.display.join("");

/**
 * The mic. With a model downloaded it starts dictating; before that it
 * opens a short setup popover offering the default model, so the first
 * click is never a dead end.
 *
 * `children` replaces the default 26px icon button (New task uses a chip).
 */
export function DictationButton({
  dictation,
  disabled,
  className,
  children,
  settingsLink = true,
}: {
  dictation: Dictation;
  disabled?: boolean | undefined;
  className?: string;
  children?: ReactNode;
  /** "More models in Settings": off inside a dialog the sheet would open under. */
  settingsLink?: boolean;
}) {
  const { setupOpen, setSetupOpen, start, phase } = dictation;
  return (
    <Popover.Root open={setupOpen} onOpenChange={setSetupOpen}>
      <Popover.Anchor asChild>
        {children ?? (
          <button
            type="button"
            aria-label="Dictate"
            title={`Dictate (${DICTATE})`}
            aria-keyshortcuts="Meta+Shift+D"
            disabled={disabled || phase !== "idle"}
            onClick={start}
            className={cn(
              "grid size-[26px] shrink-0 place-items-center rounded-(--radius-control) text-(--color-text-muted)",
              "transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
              "focus-visible:outline-none focus-visible:shadow-(--ring-focus) disabled:opacity-40",
              className,
            )}
          >
            <Mic aria-hidden className="size-[14px]" strokeWidth={2} />
          </button>
        )}
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label="Set up voice input"
          className="z-(--z-popover) w-[300px] overflow-hidden surface-floating p-[14px] data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <VoiceSetup
            onReady={() => {
              setSetupOpen(false);
              // Let the popover close (and focus return) before the mic opens.
              window.setTimeout(start, 0);
            }}
            settingsLink={settingsLink}
            onOpenSettings={() => setSetupOpen(false)}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function VoiceSetup({
  onReady,
  settingsLink,
  onOpenSettings,
}: {
  onReady: () => void;
  settingsLink: boolean;
  onOpenSettings: () => void;
}) {
  const { data: models } = useVoiceModels();
  const download = useDownloadVoiceModel();
  const settings = useSettingsRoute();
  const installed = models?.find((m) => m.installed) ?? null;
  // Offer whatever is already downloading, else the first (smallest, fastest).
  const offer: VoiceModel | null = models?.find((m) => m.downloading !== null) ?? models?.[0] ?? null;

  return (
    <div className="flex flex-col gap-[10px] text-[12.5px]">
      <div className="flex items-center gap-[8px]">
        <span className="grid size-[24px] place-items-center rounded-full bg-(--color-bg-elevated) text-(--color-text-secondary)">
          <Mic aria-hidden className="size-[13px]" />
        </span>
        <span className="text-[13px] font-medium text-(--color-text-primary)">Voice input</span>
      </div>
      <p className="m-0 leading-[1.5] text-(--color-text-secondary)">
        Talk instead of typing. Whisper turns speech into text on this Mac — your voice never leaves it. It needs a
        one-time model download.
      </p>
      {installed ? (
        <div className="flex items-center gap-[8px]">
          <span className="flex-1 text-(--color-text-muted)">
            Ready · press <span className="font-mono">{DICTATE}</span> to dictate
          </span>
          <Button variant="primary" size="sm" onClick={onReady}>
            Start dictating
          </Button>
        </div>
      ) : offer ? (
        <ModelOffer
          model={offer}
          onDownload={() => download.mutate(offer.id)}
          pending={download.isPending}
        />
      ) : (
        <span className="text-(--color-text-muted)">Loading…</span>
      )}
      {settingsLink ? (
        <button
          type="button"
          onClick={() => {
            onOpenSettings();
            settings.open("voice");
          }}
          className="self-start rounded-(--radius-chip) text-[12px] text-(--color-text-muted) transition-colors hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          More models in Settings → Voice
        </button>
      ) : null}
    </div>
  );
}

function ModelOffer({ model, onDownload, pending }: { model: VoiceModel; onDownload: () => void; pending: boolean }) {
  if (model.downloading !== null) {
    return <DownloadProgress model={model} />;
  }
  return (
    <div className="flex items-center gap-[10px] rounded-(--radius-control) bg-(--color-bg-elevated) px-[10px] py-[8px]">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-(--color-text-primary)">{model.label}</span>
        <span className="truncate text-[11.5px] text-(--color-text-muted)">
          {model.detail} · {formatBytes(model.sizeBytes)}
        </span>
      </span>
      <Button variant="primary" size="sm" disabled={pending} onClick={onDownload}>
        Download
      </Button>
    </div>
  );
}

/** A thin bar and bytes so far, with Cancel. `compact`: one line, for a settings row. */
export function DownloadProgress({ model, compact = false }: { model: VoiceModel; compact?: boolean }) {
  const done = model.downloading ?? 0;
  const pct = model.sizeBytes > 0 ? Math.min(100, (done / model.sizeBytes) * 100) : 0;
  const bar = (
    <span
      role="progressbar"
      aria-label={`Downloading ${model.label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="block h-[4px] w-full overflow-hidden rounded-full bg-(--color-bg-hover)"
    >
      <span
        className="block h-full rounded-full bg-(--color-accent-500) transition-[width] duration-200 ease-out"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
  const cancel = (
    <Button variant="ghost" size="sm" onClick={() => void tauri.cancelVoiceModelDownload(model.id)}>
      Cancel
    </Button>
  );
  if (compact) {
    return (
      <div className="flex items-center gap-[10px]">
        <span className="min-w-0 flex-1">{bar}</span>
        <span className="w-[32px] shrink-0 text-right text-[11px] tabular-nums text-(--color-text-muted)">
          {Math.round(pct)}%
        </span>
        {cancel}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[8px] rounded-(--radius-control) bg-(--color-bg-elevated) px-[10px] py-[8px]">
      <div className="flex items-center gap-[10px]">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium text-(--color-text-primary)">Downloading {model.label}</span>
          <span className="truncate text-[11.5px] tabular-nums text-(--color-text-muted)">
            {formatBytes(done)} of {formatBytes(model.sizeBytes)}
          </span>
        </span>
        {cancel}
      </div>
      {bar}
    </div>
  );
}

/** New task's chip version of the mic: the dashed "adds a value" look of Attach. */
export const DictateChip = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      title={`Dictate (${DICTATE})`}
      aria-keyshortcuts="Meta+Shift+D"
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-[6px] whitespace-nowrap rounded-(--radius-control) px-[8px]",
        "border border-dashed border-(--color-border-default) bg-transparent text-[12px] leading-none text-(--color-text-muted)",
        "transition-[background-color,color,scale] duration-(--dur-1) ease-(--ease-out) motion-safe:active:scale-[.98]",
        "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
        "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <Mic aria-hidden className="size-[12px] shrink-0" strokeWidth={2} />
      Dictate
    </button>
  ),
);
DictateChip.displayName = "DictateChip";
