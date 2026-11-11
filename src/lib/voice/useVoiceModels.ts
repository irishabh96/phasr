import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { VOICE_MODEL_EVENT } from "@/lib/events";
import { humanizeError } from "@/lib/humanizeError";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import type { VoiceModel, VoiceModelProgress } from "@/lib/types";

export const voiceKeys = {
  models: ["voice", "models"] as const,
};

export function useVoiceModels() {
  return useQuery({ queryKey: voiceKeys.models, queryFn: tauri.listVoiceModels, staleTime: 60_000 });
}

/** Fold a progress event into the cached list. Pure, for tests. */
export function applyModelProgress(models: VoiceModel[] | undefined, p: VoiceModelProgress): VoiceModel[] | undefined {
  if (!models) return models;
  return models.map((m) => {
    if (m.id !== p.modelId) return m;
    switch (p.phase) {
      case "downloading":
        return { ...m, downloading: p.downloaded };
      case "done":
        return { ...m, installed: true, downloading: null };
      default:
        return { ...m, downloading: null };
    }
  });
}

/**
 * Mounted once (`useAppEvents`): download progress into the model list,
 * wherever it was started from, and a toast when one fails.
 */
export function useVoiceModelEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<VoiceModelProgress>(VOICE_MODEL_EVENT, ({ payload }) => {
      qc.setQueryData<VoiceModel[]>(voiceKeys.models, (prev) => applyModelProgress(prev, payload));
      if (payload.phase === "failed") {
        showToast({
          intent: "error",
          title: "Couldn't download the speech model",
          ...(payload.error ? { message: humanizeError(payload.error) } : {}),
        });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [qc]);
}

/** Start a download; the list shows progress at once (before the first event). */
export function useDownloadVoiceModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tauri.downloadVoiceModel(id),
    onMutate: (id) => {
      qc.setQueryData<VoiceModel[]>(voiceKeys.models, (prev) =>
        prev?.map((m) => (m.id === id && !m.installed ? { ...m, downloading: m.downloading ?? 0 } : m)),
      );
    },
    onError: (err, id) => {
      qc.setQueryData<VoiceModel[]>(voiceKeys.models, (prev) =>
        prev?.map((m) => (m.id === id ? { ...m, downloading: null } : m)),
      );
      showToast({ intent: "error", title: "Couldn't download the speech model", message: humanizeError(err) });
    },
  });
}

export function useDeleteVoiceModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tauri.deleteVoiceModel(id),
    onSettled: () => qc.invalidateQueries({ queryKey: voiceKeys.models }),
    onError: (err) => showToast({ intent: "error", title: "Couldn't delete the model", message: humanizeError(err) }),
  });
}
