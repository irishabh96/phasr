import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function useSetAgentEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      tauri.setAgentEnabled(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

export function useSetAgentCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, command }: { id: string; command: string }) =>
      tauri.setAgentCommand(id, command),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

export function useSetAgentDefault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tauri.setAgentDefault(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

export function useCreateCustomAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; command: string }) =>
      tauri.createCustomAgent(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tauri.deleteAgent(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}
