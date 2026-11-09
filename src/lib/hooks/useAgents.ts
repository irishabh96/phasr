import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

export const agentKeys = {
  all: ["agents"] as const,
};

export function useAgents() {
  return useQuery({
    queryKey: agentKeys.all,
    queryFn: () => tauri.listAgents(),
  });
}

/** `<agent> --version` on the login-shell PATH, cached by the backend. */
export function useAgentDetection() {
  return useQuery({
    queryKey: [...agentKeys.all, "detection"] as const,
    queryFn: () => tauri.detectAgents(false),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** git / gh / shell readiness for first run. */
export function useEnvironmentCheck() {
  return useQuery({
    queryKey: ["environment"] as const,
    queryFn: () => tauri.checkEnvironment(false),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
