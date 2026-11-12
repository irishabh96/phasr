import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { GlassSelect } from "@/components/ui/GlassSelect";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SettingsCard, SettingsRow } from "@/components/ui/SettingsRow";
import { Switch } from "@/components/ui/Switch";
import { DownloadProgress } from "@/components/voice/DictationButton";
import { SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import type { GlobeKeyAction, MicAccess, VoiceModel } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  activePolisher,
  activeVoiceModel,
  formatBytes,
  setVoiceFnHold,
  setVoiceLanguage,
  setVoiceModel,
  setVoicePolish,
  type PolishPref,
  useVoicePrefs,
  VOICE_LANGUAGES,
} from "@/lib/voice/prefs";
import {
  useDeleteVoiceModel,
  useDictationPolishers,
  useDownloadVoiceModel,
  useVoiceModels,
} from "@/lib/voice/useVoiceModels";

const MIC_LABEL: Record<MicAccess, string> = {
  authorized: "Allowed",
  "not-determined": "macOS asks the first time you dictate",
  denied: "Not allowed — dictation can't hear you",
  restricted: "Blocked on this Mac",
  unsupported: "Voice input needs macOS",
};

/** What macOS also does when you let go of fn (Keyboard › "Press 🌐 key to"). */
const GLOBE_CLASH: Partial<Record<GlobeKeyAction, string>> = {
  emoji: "opens the emoji picker",
  "input-source": "switches the input source",
  dictation: "starts its own dictation",
};

/**
 * Settings › Voice. Whisper models are downloaded here (or from the mic's
 * first click), kept in this Mac's app data and never synced; the radio
 * picks the one dictation uses.
 */
export function VoiceSection() {
  const { data: models, isLoading } = useVoiceModels();
  const prefs = useVoicePrefs();
  const active = activeVoiceModel(models, prefs.modelId);
  const download = useDownloadVoiceModel();
  const remove = useDeleteVoiceModel();
  const [deleting, setDeleting] = useState<VoiceModel | null>(null);
  const { data: polishers } = useDictationPolishers();
  const polisher = activePolisher(prefs.polish, polishers);
  const mic = useQuery({ queryKey: ["voice", "mic"], queryFn: tauri.microphoneAccess, refetchOnWindowFocus: true });
  const globe = useQuery({ queryKey: ["voice", "globe"], queryFn: tauri.globeKeyAction, refetchOnWindowFocus: true });
  const clash = prefs.fnHold && globe.data ? GLOBE_CLASH[globe.data] : undefined;

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard title="Speech model · runs on this Mac, nothing is uploaded">
        <div role="radiogroup" aria-label="Speech model" id="settings-row-voice-model" data-settings-row>
          {isLoading ? <div className="px-3.5 py-3 text-[12px] text-(--color-text-muted)">Loading…</div> : null}
          {models?.map((m) => {
            const selected = active?.id === m.id;
            return (
              <div key={m.id} className="flex min-h-[52px] items-center gap-3 px-3.5 py-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`Use ${m.label}`}
                  disabled={!m.installed}
                  onClick={() => setVoiceModel(m.id)}
                  className={cn(
                    "grid size-[16px] shrink-0 place-items-center rounded-full shadow-[inset_0_0_0_1.5px_var(--color-border-strong)] transition-shadow",
                    "focus-visible:outline-none focus-visible:shadow-(--ring-focus) disabled:opacity-40",
                    selected && "shadow-[inset_0_0_0_1.5px_var(--color-accent-500)]",
                  )}
                >
                  {selected ? <span className="size-[8px] rounded-full bg-(--color-accent-500)" /> : null}
                </button>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[12px] font-medium text-(--color-text-primary)">
                    {m.label}
                    {selected ? (
                      <span className="rounded-(--radius-chip) bg-(--color-bg-elevated) px-1.5 text-[11px] font-normal leading-[18px] text-(--color-text-secondary)">
                        In use
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-[12px] text-(--color-text-muted)">
                    {m.detail} · {formatBytes(m.sizeBytes)}
                  </span>
                </span>
                <span className="flex w-[220px] shrink-0 items-center justify-end">
                  {m.downloading !== null ? (
                    <span className="w-full">
                      <DownloadProgress model={m} compact />
                    </span>
                  ) : m.installed ? (
                    <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setDeleting(m)}>
                      Delete
                    </Button>
                  ) : (
                    <Button size="sm" disabled={download.isPending} onClick={() => download.mutate(m.id)}>
                      Download
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          id="settings-row-voice-cleanup"
          label="Clean up the transcript"
          help={
            polisher
              ? `After you stop, ${polisher.label} fixes misheard terms, punctuation and filler words through your own login (a few seconds; Esc keeps it as heard).`
              : "Off: the text goes in exactly as Whisper heard it."
          }
        >
          <SegmentedControl<PolishPref>
            label="Clean up with"
            value={polisher?.id ?? "off"}
            onChange={setVoicePolish}
            options={[
              { value: "off", label: "Off" },
              ...(polishers ?? []).map((p) => ({
                value: p.id as PolishPref,
                label: p.label,
                disabled: !p.available,
              })),
            ]}
          />
        </SettingsRow>
        {active?.languages === "multilingual" ? (
          <SettingsRow
            id="settings-row-voice-language"
            label="Spoken language"
            help="Picking yours is faster and more accurate than detecting it"
            htmlFor="voice-language"
          >
            <GlassSelect
              id="voice-language"
              className="w-[200px]"
              value={prefs.language}
              onChange={(e) => setVoiceLanguage(e.target.value)}
              options={VOICE_LANGUAGES.map((l) => ({ label: l.label, value: l.code }))}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          id="settings-row-microphone"
          label="Microphone"
          help={mic.data ? MIC_LABEL[mic.data] : "…"}
        >
          {mic.data === "denied" || mic.data === "restricted" ? (
            <Button size="sm" onClick={() => void tauri.openMicrophoneSettings()}>
              Open System Settings
            </Button>
          ) : null}
        </SettingsRow>
        <SettingsRow
          label="Dictate"
          help="In a reply box or a new task's prompt. Esc cancels, ↵ inserts the text."
        >
          <span className="font-mono text-[12px] text-(--color-text-secondary)">
            {SHORTCUTS.dictate.display.join("")}
          </span>
        </SettingsRow>
        <SettingsRow
          id="settings-row-voice-fn"
          label="Hold fn to talk"
          help={
            clash
              ? `Let go to insert the text. macOS also ${clash} when you let go of fn — set Keyboard › "Press 🌐 key to" to Do Nothing.`
              : "Hold fn (🌐) while Phasr is in front and talk into the box you're in; let go to insert the text."
          }
        >
          <span className="flex items-center gap-2">
            {clash ? (
              <Button size="sm" onClick={() => void tauri.openKeyboardSettings()}>
                Open Keyboard Settings
              </Button>
            ) : null}
            <Switch checked={prefs.fnHold} onChange={setVoiceFnHold} label="Hold fn to talk" />
          </span>
        </SettingsRow>
      </SettingsCard>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the ${deleting?.label.toLowerCase() ?? ""} model?`}
        description={`Frees ${deleting ? formatBytes(deleting.sizeBytes) : ""}. You can download it again any time.`}
        confirmLabel="Delete model"
        destructive
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
