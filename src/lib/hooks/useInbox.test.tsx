import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInboxEvents, useNotifications, useOnInboxCreated, useUnreadCount } from "@/lib/hooks/useInbox";
import type { AppNotification } from "@/lib/types";

type Handler = (e: { payload: AppNotification }) => void;
const handlers: Handler[] = [];
const listen = vi.fn((_event: string, handler: Handler) => {
  handlers.push(handler);
  return Promise.resolve(() => {});
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => listen(event, handler),
}));
vi.mock("@/lib/tauri", () => ({
  tauri: {
    listNotifications: () => Promise.resolve([]),
    unreadNotificationCount: () => Promise.resolve(0),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  handlers.length = 0;
  listen.mockClear();
});

describe("inbox events", () => {
  it("the bell's query hooks open no subscription of their own", () => {
    renderHook(
      () => {
        useNotifications();
        useUnreadCount();
      },
      { wrapper },
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it("one subscription fans out to every delivery listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(
      () => {
        useInboxEvents();
        useOnInboxCreated(a);
        useOnInboxCreated(b);
      },
      { wrapper },
    );
    expect(listen).toHaveBeenCalledTimes(1);
    const n = { id: "n1", kind: "needs_approval" } as AppNotification;
    handlers[0]!({ payload: n });
    expect(a).toHaveBeenCalledWith(n);
    expect(b).toHaveBeenCalledWith(n);
  });

  it("an unmounted listener is no longer called", () => {
    const a = vi.fn();
    renderHook(() => useInboxEvents(), { wrapper });
    const { unmount } = renderHook(() => useOnInboxCreated(a), { wrapper });
    unmount();
    handlers[0]!({ payload: { id: "n2", kind: "checks_finished" } as AppNotification });
    expect(a).not.toHaveBeenCalled();
  });
});
