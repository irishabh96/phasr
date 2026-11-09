import { useAgentSignalEvents } from "@/lib/hooks/useAgentSignals";
import { useCheckEvents } from "@/lib/hooks/useReview";
import { useTaskCardEvents } from "@/lib/hooks/useTaskCards";

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
}
