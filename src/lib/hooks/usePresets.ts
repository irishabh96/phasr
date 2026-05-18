import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

const presetKeys = {
  all: ["presets"] as const,
};

export function usePresets() {
  return useQuery({
    queryKey: presetKeys.all,
    queryFn: () => tauri.listPresets(),
  });
}

export function useSetPresetEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      tauri.setPresetEnabled(id, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: presetKeys.all });
    },
  });
}
