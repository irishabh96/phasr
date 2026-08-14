import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  nextTerminalFontSize,
  settingsKeys,
  TERMINAL_FONT_SIZE,
  useAdjustTerminalFontSize,
} from "@/lib/hooks/useUserSettings";
import type { UserSettings } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getUserSettings: vi.fn<() => Promise<unknown>>(),
  updateUserSettings: vi.fn<(settings: unknown) => Promise<unknown>>(),
}));

vi.mock("@/lib/tauri", () => ({
  tauri: {
    getUserSettings: mocks.getUserSettings,
    updateUserSettings: mocks.updateUserSettings,
  },
}));

describe("nextTerminalFontSize", () => {
  it("steps by the given delta", () => {
    expect(nextTerminalFontSize(13, 1)).toBe(14);
    expect(nextTerminalFontSize(13, -1)).toBe(12);
  });

  it("clamps at both bounds", () => {
    expect(nextTerminalFontSize(TERMINAL_FONT_SIZE.max, 1)).toBe(
      TERMINAL_FONT_SIZE.max,
    );
    expect(nextTerminalFontSize(TERMINAL_FONT_SIZE.min, -1)).toBe(
      TERMINAL_FONT_SIZE.min,
    );
    expect(nextTerminalFontSize(100, 1)).toBe(TERMINAL_FONT_SIZE.max);
    expect(nextTerminalFontSize(1, -1)).toBe(TERMINAL_FONT_SIZE.min);
  });

  it("steps from the clamped bound when the stored value is out of range", () => {
    // A synced 40 displays as 24, so ⌘− must land on 23 — not on 39.
    expect(nextTerminalFontSize(40, -1)).toBe(23);
    expect(nextTerminalFontSize(40, 1)).toBe(TERMINAL_FONT_SIZE.max);
    expect(nextTerminalFontSize(4, 1)).toBe(TERMINAL_FONT_SIZE.min + 1);
  });

  it("reset returns the default from anywhere", () => {
    expect(nextTerminalFontSize(24, "reset")).toBe(TERMINAL_FONT_SIZE.default);
    expect(nextTerminalFontSize(9, "reset")).toBe(TERMINAL_FONT_SIZE.default);
  });

  it("recovers from a corrupt stored value", () => {
    expect(nextTerminalFontSize(Number.NaN, 1)).toBe(
      TERMINAL_FONT_SIZE.default + 1,
    );
  });
});

// ── useAdjustTerminalFontSize (mutation semantics) ─────────────────────────

const makeSettings = (baseFontSize: number) =>
  ({ baseFontSize, monoFont: "SF Mono" }) as unknown as UserSettings;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(seed?: UserSettings) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (seed) client.setQueryData(settingsKeys.current, seed);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useAdjustTerminalFontSize(), { wrapper });
  const cached = () =>
    client.getQueryData<UserSettings>(settingsKeys.current)?.baseFontSize;
  return { client, result, cached };
}

describe("useAdjustTerminalFontSize", () => {
  beforeEach(() => {
    mocks.getUserSettings.mockReset().mockResolvedValue(makeSettings(13));
    mocks.updateUserSettings
      .mockReset()
      .mockImplementation(async (settings) => settings);
  });

  it("fires no mutation at a bound or on a redundant reset", async () => {
    const atMax = setup(makeSettings(TERMINAL_FONT_SIZE.max));
    await act(async () => atMax.result.current(1));
    const atMin = setup(makeSettings(TERMINAL_FONT_SIZE.min));
    await act(async () => atMin.result.current(-1));
    const atDefault = setup(makeSettings(TERMINAL_FONT_SIZE.default));
    await act(async () => atDefault.result.current("reset"));
    expect(mocks.updateUserSettings).not.toHaveBeenCalled();
  });

  it("no-ops until the settings query has resolved", async () => {
    const { result } = setup();
    await act(async () => result.current(1));
    expect(mocks.updateUserSettings).not.toHaveBeenCalled();
  });

  it("writes the cache optimistically before the IPC resolves", async () => {
    const gate = deferred<UserSettings>();
    mocks.updateUserSettings.mockImplementation(() => gate.promise);
    const { result, cached } = setup(makeSettings(13));

    await act(async () => result.current(1));

    expect(cached()).toBe(14);
    expect(mocks.updateUserSettings).toHaveBeenCalledWith(
      expect.objectContaining({ baseFontSize: 14 }),
    );
    await act(async () => gate.resolve(makeSettings(14)));
  });

  it("rolls the cache back when the IPC fails", async () => {
    const gate = deferred<UserSettings>();
    mocks.updateUserSettings.mockImplementation(() => gate.promise);
    const { result, cached } = setup(makeSettings(13));

    await act(async () => result.current(1));
    expect(cached()).toBe(14);

    await act(async () => gate.reject(new Error("sqlite is on fire")));
    await waitFor(() => expect(cached()).toBe(13));
  });

  it("serializes queued presses and drops a stale late echo", async () => {
    const first = deferred<UserSettings>();
    mocks.updateUserSettings
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (settings) => settings);
    const { result, cached } = setup(makeSettings(13));

    await act(async () => result.current(1));
    await act(async () => result.current(1));

    // Both presses landed optimistically; the second IPC is queued behind
    // the first (mutation scope), not racing it.
    expect(cached()).toBe(15);
    expect(mocks.updateUserSettings).toHaveBeenCalledTimes(1);

    // The first response arrives after a newer press — it must not regress
    // the cache.
    await act(async () => first.resolve(makeSettings(14)));
    expect(cached()).toBe(15);

    await waitFor(() =>
      expect(mocks.updateUserSettings).toHaveBeenCalledTimes(2),
    );
    expect(
      (mocks.updateUserSettings.mock.calls[1]?.[0] as UserSettings)
        .baseFontSize,
    ).toBe(15);
    await waitFor(() => expect(cached()).toBe(15));
  });
});
