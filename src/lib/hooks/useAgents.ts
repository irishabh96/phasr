import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

const agentKeys = {
  all: ["agents"] as const,
};

export function useAgents() {
  return useQuery({
    queryKey: agentKeys.all,
    queryFn: () => tauri.listAgents(),
  });
}
