import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSurfaceRecency,
  getParkHost,
  isParked,
  maxCachedSurfaces,
  parkSurface,
  TerminalSurfaceCache,
  type SurfaceCacheEntry,
} from "@/lib/terminal/cache";
import type { TerminalSurface } from "@/lib/terminal/surface";

/** Just enough surface for the cache: an element, and a recording dispose. */
function fakeSurface(id: string) {
  const element = document.createElement("div");
  const surface = {
    id,
    kind: "ghostty",
    element,
    disposed: false,
    active: null as boolean | null,
    setActive(active: boolean) {
      this.active = active;
    },
    dispose() {
      this.disposed = true;
      element.parentNode?.removeChild(element);
    },
  };
  return surface as unknown as TerminalSurface & {
    disposed: boolean;
    active: boolean | null;
  };
}

type Entry = SurfaceCacheEntry & { surface: ReturnType<typeof fakeSurface> };

function entryFor(id: string): Entry {
  return { surface: fakeSurface(id), inputDisposables: [] };
}

/** Mount into the document, as a live component's slot would. */
function mount(entry: Entry) {
  document.body.appendChild(entry.surface.element);
}

describe("TerminalSurfaceCache", () => {
  beforeEach(() => {
    __resetSurfaceRecency();
    localStorage.clear();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("defaults to 8 and honours the localStorage override", () => {
    expect(maxCachedSurfaces()).toBe(8);
    localStorage.setItem("phasr.terminal.maxCached", "3");
    expect(maxCachedSurfaces()).toBe(3);
    // Garbage must not silently disable the bound.
    localStorage.setItem("phasr.terminal.maxCached", "not a number");
    expect(maxCachedSurfaces()).toBe(8);
    localStorage.setItem("phasr.terminal.maxCached", "0");
    expect(maxCachedSurfaces()).toBe(8);
  });

  it("evicts the least-recently-used PARKED surface once over the bound", () => {
    localStorage.setItem("phasr.terminal.maxCached", "2");
    const cache = new TerminalSurfaceCache<Entry>("t");

    const a = entryFor("a");
    const b = entryFor("b");
    cache.set("a", a);
    cache.set("b", b);
    parkSurface(a.surface);
    parkSurface(b.surface);

    const c = entryFor("c");
    cache.set("c", c);

    // `a` was the oldest and was parked, so it went.
    expect(a.surface.disposed).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    expect(b.surface.disposed).toBe(false);
    expect(c.surface.disposed).toBe(false);
  });

  it("a `get` counts as use, so it is not the next thing evicted", () => {
    localStorage.setItem("phasr.terminal.maxCached", "2");
    const cache = new TerminalSurfaceCache<Entry>("t");
    const a = entryFor("a");
    const b = entryFor("b");
    cache.set("a", a);
    cache.set("b", b);
    parkSurface(a.surface);
    parkSurface(b.surface);

    cache.get("a"); // `a` is now the most recent, `b` the oldest.
    cache.set("c", entryFor("c"));

    expect(a.surface.disposed).toBe(false);
    expect(b.surface.disposed).toBe(true);
  });

  it("NEVER evicts a mounted surface, even as the oldest", () => {
    // The safety property. A mounted component holds this surface and will
    // not re-run its mount effect, so disposing it would blank the terminal
    // permanently rather than merely cost scrollback.
    localStorage.setItem("phasr.terminal.maxCached", "1");
    const cache = new TerminalSurfaceCache<Entry>("t");

    const mounted = entryFor("mounted");
    cache.set("mounted", mounted);
    mount(mounted);

    const parked = entryFor("parked");
    cache.set("parked", parked);
    parkSurface(parked.surface);

    cache.set("third", entryFor("third"));

    expect(mounted.surface.disposed).toBe(false);
    expect(cache.get("mounted")).toBeDefined();
    // The parked one absorbed the pressure instead.
    expect(parked.surface.disposed).toBe(true);
  });

  it("shares one budget across cache instances", () => {
    // Two caches policing themselves at 8 each would be 16 live terminals —
    // exactly the GPU-context ceiling the bound exists to stay under.
    localStorage.setItem("phasr.terminal.maxCached", "2");
    const agents = new TerminalSurfaceCache<Entry>("agent");
    const shells = new TerminalSurfaceCache<Entry>("shell");

    const a = entryFor("1");
    agents.set("1", a);
    parkSurface(a.surface);
    const s1 = entryFor("1");
    shells.set("1", s1); // same id, different namespace
    parkSurface(s1.surface);

    expect(a.surface.disposed).toBe(false);
    shells.set("2", entryFor("2"));

    expect(a.surface.disposed).toBe(true);
    expect(s1.surface.disposed).toBe(false);
  });

  it("eviction runs the entry's input disposables", () => {
    localStorage.setItem("phasr.terminal.maxCached", "1");
    const cache = new TerminalSurfaceCache<Entry>("t");
    const dispose = vi.fn();
    const a = entryFor("a");
    a.inputDisposables = [{ dispose }];
    cache.set("a", a);
    parkSurface(a.surface);

    cache.set("b", entryFor("b"));

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("onEvict fires AT eviction, before dispose — and never for an explicit dispose", () => {
    // The hook perf phase 4's report asked for: the detach used to wait
    // for the next chunk to notice the surface was gone. Order matters —
    // the callback must see the entry while its surface is still alive,
    // because the component reads its channel id off it.
    localStorage.setItem("phasr.terminal.maxCached", "1");
    const evicted: { id: string; disposedYet: boolean }[] = [];
    const cache = new TerminalSurfaceCache<Entry>("t", (entry) =>
      evicted.push({
        id: entry.surface.id,
        disposedYet: entry.surface.disposed,
      }),
    );
    const a = entryFor("a");
    cache.set("a", a);
    parkSurface(a.surface);

    // Explicit dispose: the caller owns the stream — no hook.
    cache.dispose("a");
    expect(evicted).toEqual([]);

    const b = entryFor("b");
    cache.set("b", b);
    parkSurface(b.surface);
    cache.set("c", entryFor("c"));

    expect(evicted).toEqual([{ id: "b", disposedYet: false }]);
    expect(b.surface.disposed).toBe(true);
  });

  it("parking deactivates the surface and moves it to the park host", () => {
    const a = entryFor("a");
    mount(a);
    expect(isParked(a.surface)).toBe(false);

    parkSurface(a.surface);

    expect(a.surface.active).toBe(false);
    expect(isParked(a.surface)).toBe(true);
    expect(getParkHost().contains(a.surface.element)).toBe(true);
  });
});
