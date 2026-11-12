import type { Ghostty } from "ghostty-web";

/**
 * Every grid gets its own WebAssembly instance.
 *
 * Ghostty's page code assumes a fresh page is zeroed — true natively, where
 * pages come from `mmap`. In WASM they come from the module's page
 * allocator, which hands a freed page to the next allocation with the old
 * bytes still in it. With one shared instance that meant:
 *
 * - a new terminal (or a rebuilt grid) was BORN holding another terminal's
 *   cells: a closed task's output, or pointer bytes read as codepoints
 *   (a row of tofu glyphs), until the shell happened to overwrite them;
 * - writing styled or grapheme-bearing output (emoji, combining marks —
 *   exactly what agent TUIs print) into recycled pages trapped with
 *   `memory access out of bounds`: the trap behind `quarantinedGrids` and
 *   the rebuild retries.
 *
 * A fresh instance's memory is zeroed by definition, and dropping the
 * instance returns all of it to the browser — nothing is ever recycled
 * between grids. Instantiating a compiled module is ~0.3 ms and ~1.2 MB.
 *
 * `createTerminal` is synchronous (it runs inside `Terminal.open()`,
 * `reset()` and the rebuild's grid swap), so instances are prepared ahead:
 * a small pool refilled asynchronously after each take. An empty pool falls
 * back to synchronous instantiation, and only if the platform refuses that
 * too to the shared instance — the old behaviour, never a failed terminal.
 */

const POOL_SIZE = 2;

type Instantiate = () => Promise<WebAssembly.Instance>;

export interface GridEngine {
  /** Passed to `Terminal` as `options.ghostty`. */
  ghostty: Ghostty;
  /** Live grid instances plus the shared one, in bytes (DEV probe). */
  wasmBytes(): number;
}

function vtImports(memory: () => WebAssembly.Memory | undefined): WebAssembly.Imports {
  return {
    env: {
      log: (ptr: number, len: number) => {
        const mem = memory();
        if (!mem) return;
        console.log("[ghostty-vt]", new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len)));
      },
    },
  };
}

export async function instantiateVt(module: WebAssembly.Module): Promise<WebAssembly.Instance> {
  let instance: WebAssembly.Instance | undefined;
  instance = await WebAssembly.instantiate(
    module,
    vtImports(() => instance?.exports.memory as WebAssembly.Memory | undefined),
  );
  return instance;
}

function instantiateVtSync(module: WebAssembly.Module): WebAssembly.Instance {
  let instance: WebAssembly.Instance | undefined = undefined;
  instance = new WebAssembly.Instance(
    module,
    vtImports(() => instance?.exports.memory as WebAssembly.Memory | undefined),
  );
  return instance;
}

interface FreeableGrid {
  free(): void;
}

/**
 * Wrap the shared `Ghostty` so `createTerminal` builds each grid in a fresh
 * instance; everything else (key encoders) stays on the shared one.
 */
export function isolateGrids(
  GhosttyClass: new (instance: WebAssembly.Instance) => Ghostty,
  shared: Ghostty,
  module: WebAssembly.Module,
  instantiate: Instantiate = () => instantiateVt(module),
): GridEngine {
  const pool: WebAssembly.Instance[] = [];
  let filling = 0;
  const live = new Set<WebAssembly.Memory>();

  const refill = () => {
    while (pool.length + filling < POOL_SIZE) {
      filling++;
      instantiate()
        .then((instance) => pool.push(instance))
        .catch((err) => console.warn("[terminal] could not pre-instantiate a grid engine", err))
        .finally(() => {
          filling--;
        });
    }
  };
  refill();

  const take = (): WebAssembly.Instance | null => {
    const ready = pool.pop();
    refill();
    if (ready) return ready;
    try {
      return instantiateVtSync(module);
    } catch (err) {
      console.warn("[terminal] synchronous grid engine refused; using the shared instance", err);
      return null;
    }
  };

  const ghostty = new Proxy(shared, {
    get(target, prop, receiver) {
      if (prop !== "createTerminal") return Reflect.get(target, prop, receiver);
      return (...args: Parameters<Ghostty["createTerminal"]>) => {
        const instance = take();
        if (!instance) return target.createTerminal(...args);
        const engine = new GhosttyClass(instance);
        const grid = engine.createTerminal(...args);
        const memory = instance.exports.memory as WebAssembly.Memory;
        live.add(memory);
        const free = (grid as unknown as FreeableGrid).free.bind(grid);
        // Freeing inside a private instance only matters for the probe:
        // the instance (and its memory) goes with the last reference.
        (grid as unknown as FreeableGrid).free = () => {
          live.delete(memory);
          free();
        };
        return grid;
      };
    },
  });

  return {
    ghostty,
    wasmBytes: () => {
      const sharedMemory = (shared as unknown as { memory?: WebAssembly.Memory }).memory;
      let total = sharedMemory?.buffer.byteLength ?? 0;
      for (const memory of live) total += memory.buffer.byteLength;
      return total;
    },
  };
}
