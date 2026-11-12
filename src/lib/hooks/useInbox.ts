import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { NOTIFICATION_CREATED_EVENT } from "@/lib/events";
import { tauri, type ListNotificationsInput } from "@/lib/tauri";
import type { AppNotification } from "@/lib/types";

/**
 * Notifications inbox (M8). The backend records every entry and announces
 * it on `phasr://notification-created`; these hooks keep the bell count
 * and the popover list live from that event (no polling). Banner / sound
 * delivery is separate: feed `onCreated` entries to
 * `notificationPolicy.ts::shouldDeliver`.
 */

export const inboxKeys = {
  all: ["inbox"] as const,
  list: (unreadOnly: boolean, limit: number | null) =>
    [...inboxKeys.all, "list", unreadOnly, limit ?? "all"] as const,
  unread: () => [...inboxKeys.all, "unread"] as const,
};

/** Prepend a new entry to a cached list (respecting its limit). Pure; exported for tests. */
export function prependNotification(
  list: AppNotification[] | undefined,
  n: AppNotification,
  limit: number | null,
): AppNotification[] | undefined {
  if (!list) return list;
  if (list.some((x) => x.id === n.id)) return list;
  const next = [n, ...list];
  return limit !== null && next.length > limit ? next.slice(0, limit) : next;
}

type CreatedListener = (n: AppNotification) => void;
const createdListeners = new Set<CreatedListener>();

/**
 * Be told about each new entry (banners / sounds) without opening another
 * Tauri subscription — the one `useInboxEvents` (in `useAppEvents`) fans
 * out to these. Mount it once per delivery path, or each will deliver.
 */
export function useOnInboxCreated(onCreated: CreatedListener) {
  // Latest callback without re-subscribing on every render.
  const ref = useRef(onCreated);
  ref.current = onCreated;
  useEffect(() => {
    const listener: CreatedListener = (n) => ref.current(n);
    createdListeners.add(listener);
    return () => {
      createdListeners.delete(listener);
    };
  }, []);
}

/**
 * The inbox's one Tauri subscription, mounted ONCE in the app shell via
 * `useAppEvents`: cached lists get the entry prepended (idempotent by id),
 * the unread count refetches, and every `useOnInboxCreated` listener runs.
 * The query hooks below only read the cache.
 */
export function useInboxEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<AppNotification>(NOTIFICATION_CREATED_EVENT, (event) => {
      const n = event.payload;
      for (const query of queryClient.getQueryCache().findAll({ queryKey: inboxKeys.all })) {
        // A new entry is unread, so it belongs in unread-only lists too.
        const [, kind, , limit] = query.queryKey as [string, string, boolean, number | "all"];
        if (kind !== "list") continue;
        queryClient.setQueryData<AppNotification[]>(query.queryKey, (prev) =>
          prependNotification(prev, n, limit === "all" ? null : limit),
        );
      }
      // Refetch rather than +1: the backend's count is the truth.
      void queryClient.invalidateQueries({ queryKey: inboxKeys.unread() });
      for (const listener of createdListeners) listener(n);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
}

/** The inbox, newest first. */
export function useNotifications(input: ListNotificationsInput = {}) {
  const unreadOnly = input.unreadOnly ?? false;
  const limit = input.limit ?? null;
  return useQuery({
    queryKey: inboxKeys.list(unreadOnly, limit),
    queryFn: () =>
      tauri.listNotifications({
        unreadOnly,
        ...(limit !== null ? { limit } : {}),
      }),
    staleTime: Infinity,
  });
}

/** The bell's badge count. */
export function useUnreadCount() {
  return useQuery({
    queryKey: inboxKeys.unread(),
    queryFn: tauri.unreadNotificationCount,
    staleTime: Infinity,
  });
}

/** Mark entries read (`null` = all). */
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | null) => tauri.markNotificationsRead(ids),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inboxKeys.all }),
  });
}

export function useClearNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => tauri.clearNotifications(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inboxKeys.all }),
  });
}
