import { useSyncExternalStore } from "react";
import type { Polisher, PolisherInfo, VoiceModel } from "@/lib/types";

/**
 * Settings › Voice: which downloaded model dictation uses, and the spoken
 * language for multilingual models. Per Mac, like the models themselves
 * (they live in this Mac's app data), so localStorage rather than synced
 * settings.
 */
const MODEL_KEY = "phasr.voice.model";
const LANGUAGE_KEY = "phasr.voice.language";
const POLISH_KEY = "phasr.voice.polish";
const PREF_EVENT = "phasr:voice-prefs-changed";

export interface VoicePrefs {
  /** Preferred model id; null = the first one installed. */
  modelId: string | null;
  /** ISO code, or "auto". Multilingual models only. */
  language: string;
  /**
   * Clean up the transcript afterwards with a fast model: "auto" = Claude
   * Haiku if installed, else Codex's fast model, else off.
   */
  polish: PolishPref;
}

export type PolishPref = "auto" | "off" | Polisher;

let cached: VoicePrefs | null = null;

function read(): VoicePrefs {
  if (cached) return cached;
  let modelId: string | null = null;
  let language = "auto";
  let polish: PolishPref = "auto";
  try {
    modelId = localStorage.getItem(MODEL_KEY);
    language = localStorage.getItem(LANGUAGE_KEY) || "auto";
    const p = localStorage.getItem(POLISH_KEY);
    if (p === "off" || p === "claude" || p === "codex") polish = p;
  } catch {
    /* ignore */
  }
  cached = { modelId, language, polish };
  return cached;
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  cached = null;
  window.dispatchEvent(new Event(PREF_EVENT));
}

export const setVoiceModel = (id: string | null) => write(MODEL_KEY, id);
export const setVoiceLanguage = (lang: string) => write(LANGUAGE_KEY, lang);
export const setVoicePolish = (p: PolishPref) => write(POLISH_KEY, p);

function subscribe(listener: () => void) {
  const onStorage = () => {
    cached = null;
    listener();
  };
  window.addEventListener(PREF_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREF_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

const SERVER: VoicePrefs = { modelId: null, language: "auto", polish: "auto" };

export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(subscribe, read, () => SERVER);
}

/** The model dictation will use: the preferred one if it's downloaded, else the first that is. */
export function activeVoiceModel(models: readonly VoiceModel[] | undefined, preferred: string | null): VoiceModel | null {
  if (!models) return null;
  return models.find((m) => m.id === preferred && m.installed) ?? models.find((m) => m.installed) ?? null;
}

/** Spoken languages offered for multilingual models (Whisper codes). */
export const VOICE_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: "auto", label: "Detect automatically" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "tr", label: "Turkish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** The CLI that cleans up the transcript, or null for none. */
export function activePolisher(pref: PolishPref, available: readonly PolisherInfo[] | undefined): PolisherInfo | null {
  if (pref === "off" || !available) return null;
  const ok = available.filter((p) => p.available);
  if (pref === "auto") return ok.find((p) => p.id === "claude") ?? ok[0] ?? null;
  return ok.find((p) => p.id === pref) ?? null;
}
