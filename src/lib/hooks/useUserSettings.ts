import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { UserSettings } from "@/lib/types";

const settingsKeys = {
  current: ["userSettings"] as const,
};

export function useUserSettings() {
  return useQuery({
    queryKey: settingsKeys.current,
    queryFn: () => tauri.getUserSettings(),
  });
}

export function useUpdateUserSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: UserSettings) => tauri.updateUserSettings(settings),
    onSuccess: (settings) => {
      queryClient.setQueryData(settingsKeys.current, settings);
    },
  });
}
