import { useAgentSignalEvents } from "@/lib/hooks/useAgentSignals";
import { useInboxEvents } from "@/lib/hooks/useInbox";
import { useCheckEvents } from "@/lib/hooks/useReview";
import { useTaskCardEvents } from "@/lib/hooks/useTaskCards";
import { useTranscriptEvents } from "@/lib/transcript/useTranscript";
import { useFnHoldDictation } from "@/lib/voice/fnHold";
import { useVoiceModelEvents } from "@/lib/voice/useVoiceModels";

/**
 * Every app-wide Tauri event subscription, mounted ONCE in the app shell.
 * The query hooks (useTaskCards, useAgentStates, useChecks, …) only read
 * the cache; mounting a listener per consumer made each event refetch the
 * board and system status once per mounted component.
 */
export function useAppEvents() {
  useTaskCardEvents();
  useAgentSignalEvents();
  useCheckEvents();
  // Inbox cache + delivery fan-out (`useOnInboxCreated`).
  useInboxEvents();
  // Live transcript items for every cached transcript (agent transcript view).
  useTranscriptEvents();
  // Speech-model download progress (Settings › Voice, the mic's setup).
  useVoiceModelEvents();
  useFnHoldDictation();
}
