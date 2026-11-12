import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useViewedFiles, viewedKey } from "./useViewedFiles";

beforeEach(() => localStorage.clear());

describe("useViewedFiles", () => {
  it("keys by path and change size, so a re-edited file reads unviewed", () => {
    expect(viewedKey("a.ts", 3, 1)).toBe("a.ts@3:1");
    expect(viewedKey("a.ts", 4, 1)).not.toBe(viewedKey("a.ts", 3, 1));
  });

  it("toggles and persists per task", () => {
    const { result } = renderHook(() => useViewedFiles("t1"));
    act(() => result.current.toggle("a.ts@3:1"));
    expect(result.current.viewed.has("a.ts@3:1")).toBe(true);
    const again = renderHook(() => useViewedFiles("t1"));
    expect(again.result.current.viewed.has("a.ts@3:1")).toBe(true);
    const other = renderHook(() => useViewedFiles("t2"));
    expect(other.result.current.viewed.size).toBe(0);
    act(() => result.current.toggle("a.ts@3:1"));
    expect(result.current.viewed.has("a.ts@3:1")).toBe(false);
  });
});
