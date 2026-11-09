import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePrRefresh } from "@/lib/hooks/usePrRefresh";

type Opts = { onSettled?: () => void };
const calls: Opts[] = [];
const mutate = vi.fn((_arg: unknown, opts: Opts) => {
  calls.push(opts);
});

vi.mock("@/lib/hooks/useReview", () => ({
  // isPending deliberately stuck at false — the stale value the old guard read.
  useRefreshPrStates: () => ({ mutate, isPending: false }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  mutate.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("usePrRefresh", () => {
  it("does not refresh on mount (the backend does at startup)", () => {
    renderHook(() => usePrRefresh());
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refreshes on focus and on the interval", () => {
    renderHook(() => usePrRefresh());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() => calls[0]?.onSettled?.());
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it("never overlaps: a focus while one is in flight is skipped", () => {
    renderHook(() => usePrRefresh());
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() => calls[0]?.onSettled?.());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mutate).toHaveBeenCalledTimes(2);
  });
});
