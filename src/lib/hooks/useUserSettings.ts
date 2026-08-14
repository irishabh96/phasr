import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import {
  TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
} from "@/lib/terminal/fontSize";
import type { UserSettings } from "@/lib/types";

// Re-exported so font-size consumers need one import, not two.
export { TERMINAL_FONT_SIZE, clampTerminalFontSize };

export const settingsKeys = {
  current: ["userSettings"] as const,
};

export const settingsMutationKeys = {
  update: ["mirror", "updateUserSettings"] as const,
};

/** Next size for a step (`+1` / `-1`) or `"reset"`, clamped to the bounds. */
export function nextTerminalFontSize(
  current: number,
  action: number | "reset",
): number {
  if (action === "reset") return TERMINAL_FONT_SIZE.default;
  // Normalize before stepping: an out-of-range stored value (cloud sync from
  // another client) steps from the bound the UI displays, not the raw number.
  return clampTerminalFontSize(clampTerminalFontSize(current) + action);
}

export function useUserSettings() {
  return useQuery({
    queryKey: settingsKeys.current,
    queryFn: () => tauri.getUserSettings(),
  });
}

export function useUpdateUserSettings() {
  const queryClient = useQueryClient();
  // "Am I the only update still in flight?" — scoped mutations queue behind
  // each other, and only the last one may touch the cache with its result:
  // an earlier response landing between a newer press's onMutate and its
  // settle would regress the optimistic value.
  const isLastUpdate = () =>
    queryClient.isMutating({ mutationKey: settingsMutationKeys.update }) === 1;
  return useMutation({
    mutationKey: settingsMutationKeys.update,
    // Serialize the IPC: parallel key-repeat writes could reach sqlite out of
    // order and persist a stale row. onMutate is NOT queued (it runs before
    // the scope gate), so the optimistic cache below still updates per press.
    scope: { id: "user-settings" },
    mutationFn: (settings: UserSettings) => tauri.updateUserSettings(settings),
    // Optimistic: ⌘+/⌘− can repeat faster than the IPC round-trip, and each
    // press derives the next size from this cache — without the immediate
    // write the second press would recompute from the stale value and be
    // swallowed.
    onMutate: async (settings) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.current });
      const previous = queryClient.getQueryData<UserSettings>(
        settingsKeys.current,
      );
      queryClient.setQueryData(settingsKeys.current, settings);
      return { previous };
    },
    onError: (_err, _settings, context) => {
      if (!isLastUpdate()) return;
      if (context?.previous)
        queryClient.setQueryData(settingsKeys.current, context.previous);
      // The rollback value can still be wrong (a queued sibling also failed);
      // refetch the row sqlite actually holds.
      void queryClient.invalidateQueries({ queryKey: settingsKeys.current });
    },
    onSuccess: (settings) => {
      if (isLastUpdate())
        queryClient.setQueryData(settingsKeys.current, settings);
    },
  });
}

/**
 * Stable callback shared by the global ⌘+/⌘−/⌘0 dispatcher and the
 * Appearance stepper. No-ops until settings load and when a step is
 * already at a bound.
 */
export function useAdjustTerminalFontSize() {
  const queryClient = useQueryClient();
  const { mutate } = useUpdateUserSettings();
  return useCallback(
    (action: number | "reset") => {
      const current = queryClient.getQueryData<UserSettings>(
        settingsKeys.current,
      );
      if (!current) return;
      const baseFontSize = nextTerminalFontSize(current.baseFontSize, action);
      if (baseFontSize === current.baseFontSize) return;
      mutate({ ...current, baseFontSize });
    },
    [queryClient, mutate],
  );
}
