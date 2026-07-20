import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { TicketBrief, TicketComment } from "@/lib/types";

export const ticketBriefKeys = {
  all: ["ticketBrief"] as const,
  detail: (repositoryId: string, ticketId: string) =>
    ["ticketBrief", repositoryId, ticketId] as const,
  comments: (repositoryId: string, ticketId: string) =>
    ["ticketComments", repositoryId, ticketId] as const,
};

/**
 * The Brief tab's data source (spec §C.1 / F3). Reads the whole versioned brief
 * — Description/PRD/TRD content + mtimes + authorship, assets, figma links, and
 * the comment count — for a ticket (`ticketId == subtask workspace id`, §D2).
 * `enabled` gates it to real subtasks so it never fires for agent/local
 * workspaces.
 */
export function useTicketBrief(
  repositoryId: string,
  ticketId: string,
  enabled = true,
) {
  return useQuery<TicketBrief>({
    queryKey: ticketBriefKeys.detail(repositoryId, ticketId),
    queryFn: () => tauri.readTicketBrief(repositoryId, ticketId),
    enabled,
    staleTime: 10_000,
  });
}

/**
 * The Comments tab's thread (spec F5). Kept as its own query (separate from the
 * brief) because a long thread is independent of the brief body and re-reads on
 * its own cadence / on a `phasr://ticket-changed` event.
 */
export function useTicketComments(
  repositoryId: string,
  ticketId: string,
  enabled = true,
) {
  return useQuery<TicketComment[]>({
    queryKey: ticketBriefKeys.comments(repositoryId, ticketId),
    queryFn: () => tauri.listTicketComments(repositoryId, ticketId),
    enabled,
    staleTime: 10_000,
  });
}
