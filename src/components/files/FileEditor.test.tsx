import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPane } from "@/components/session/FilesPane";
import { useUiStore } from "@/lib/store";
import type { Workspace } from "@/lib/types";

/**
 * The Files pane's editor keeps unsaved work: buffers outlive the editor
 * (Edit ↔ Diff, task switches), saves are single-flight, and the editor's
 * own write is never mistaken for an agent edit.
 */

const h = vi.hoisted(() => {
  type Deferred = { resolve: () => void; reject: (e: unknown) => void };
  const state = {
    disk: new Map<string, string>(),
    /** Writes waiting for the test to release them (FIFO). */
    pendingWrites: [] as Deferred[],
    /** When true, writes wait in `pendingWrites`; otherwise they land at once. */
    holdWrites: false,
    watcher: null as null | ((e: { payload: { workspaceId: string; paths: string[] } }) => void),
  };
  const hashOf = (s: string) => `h:${s}`;
  const readWorkspaceFile = vi.fn(async (_ws: string, path: string) => {
    const contents = state.disk.get(path);
    if (contents === undefined) throw "not found";
    return { path, contents, hash: hashOf(contents), sizeBytes: contents.length, lastAgentEdit: null };
  });
  const writeWorkspaceFile = vi.fn(
    (_ws: string, path: string, contents: string, expectedHash: string | null) => {
      const land = () => {
        const cur = state.disk.get(path);
        if (expectedHash !== null && cur !== undefined && hashOf(cur) !== expectedHash) {
          throw "file changed on disk";
        }
        state.disk.set(path, contents);
        return { hash: hashOf(contents) };
      };
      if (!state.holdWrites) return Promise.resolve().then(land);
      // Held: the write hits the disk now (the watcher can see it), but the
      // command's reply waits for `releaseWrite()`.
      let outcome: { ok: true; value: { hash: string } } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: land() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      return new Promise<{ hash: string }>((resolve, reject) => {
        state.pendingWrites.push({
          resolve: () => (outcome.ok ? resolve(outcome.value) : reject(outcome.error)),
          reject,
        });
      });
    },
  );
  const showToast = vi.fn();
  return { state, hashOf, readWorkspaceFile, writeWorkspaceFile, showToast };
});

vi.mock("@/lib/tauri", () => ({
  tauri: {
    listWorkspaceTree: vi.fn(async () => ({
      files: [...h.state.disk.keys()].map((path) => ({ path, status: null })),
      truncated: false,
    })),
    readWorkspaceFile: h.readWorkspaceFile,
    writeWorkspaceFile: h.writeWorkspaceFile,
    gitStatus: vi.fn(async () => []),
    listRepoFiles: vi.fn(async () => []),
    gitDiff: vi.fn(async () => ""),
    revertHunk: vi.fn(async () => undefined),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (typeof h.state)["watcher"]) => {
    h.state.watcher = handler;
    return () => {
      if (h.state.watcher === handler) h.state.watcher = null;
    };
  }),
}));

vi.mock("@/lib/toast", () => ({ showToast: h.showToast }));

vi.mock("@/components/diff/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));

// CodeMirror is heavy in jsdom; a textarea with the same contract stands in:
// uncontrolled after mount, `value` re-applied only when `docKey` changes and
// the text differs, ⌘S calls onSave.
vi.mock("@/components/files/CodeEditor", async () => {
  const { useEffect, useRef } = await import("react");
  function MockEditor({
    docKey,
    value,
    onChange,
    onSave,
  }: {
    docKey: string;
    value: string;
    onChange: (v: string) => void;
    onSave: () => void;
  }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
      if (ref.current && ref.current.value !== value) ref.current.value = value;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docKey]);
    return (
      <textarea
        aria-label="Editor"
        ref={ref}
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.metaKey && e.key === "s") {
            e.preventDefault();
            onSave();
          }
        }}
      />
    );
  }
  return { default: MockEditor };
});

const WS = "task-1";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: WS,
    repositoryId: "repo-1",
    workspaceKind: "agent",
    name: "fix login bug",
    prompt: null,
    agent: "claude",
    command: "claude",
    status: "running",
    branch: "phasr/abcd1234",
    worktreePath: "/tmp/phasr/.phasr/worktrees/task-1",
    exitCode: null,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:01Z",
    finishedAt: null,
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:01Z",
    ...overrides,
  } as Workspace;
}

let client: QueryClient;
function pane(visible = true): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <FilesPane workspace={makeWorkspace()} visible={visible} />
    </QueryClientProvider>
  );
}

const editor = () => screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Editor" });
const type = (el: HTMLTextAreaElement, value: string) => fireEvent.change(el, { target: { value } });
const pressSave = (el: HTMLTextAreaElement) => fireEvent.keyDown(el, { key: "s", metaKey: true });
const diskBanner = () => screen.queryByText(/changed this file on disk/);
/** The fs watcher reporting `paths` changed (as after any write). */
const emitWorktreeChanged = (paths: string[]) =>
  act(async () => {
    h.state.watcher?.({ payload: { workspaceId: WS, paths } });
  });
/** Let queued microtasks (mutation start, query resolution) run. */
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const releaseWrite = () =>
  act(async () => {
    h.state.pendingWrites.shift()?.resolve();
  });

async function openFile(path = "a.ts") {
  act(() => useUiStore.getState().openSessionFile(WS, path));
  const el = await editor();
  await waitFor(() => expect(el.value).toBe(h.state.disk.get(path)));
  return el;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  h.state.disk = new Map([
    ["a.ts", "const a = 1;\n"],
    ["b.ts", "const b = 2;\n"],
  ]);
  h.state.pendingWrites = [];
  h.state.holdWrites = false;
  h.state.watcher = null;
  h.readWorkspaceFile.mockClear();
  h.writeWorkspaceFile.mockClear();
  h.showToast.mockClear();
  useUiStore.setState({ sessionFile: {}, sessionPane: {}, openFiles: {}, fileBuffers: {} });
});

afterEach(() => {
  client.clear();
});

describe("FilesPane editor buffers", () => {
  it("keeps unsaved edits across Edit → Diff → Edit", async () => {
    render(pane());
    const el = await openFile();
    type(el, "const a = 42;\n");

    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    fireEvent.click(screen.getByRole("radio", { name: "Edit" }));

    expect((await editor()).value).toBe("const a = 42;\n");
    expect(screen.getByText(/unsaved/)).toBeInTheDocument();
  });

  it("keeps unsaved edits when the pane remounts (task switch)", async () => {
    const first = render(pane());
    const el = await openFile();
    type(el, "const a = 42;\n");
    first.unmount();

    render(pane());
    const again = await editor();
    await waitFor(() => expect(again.value).toBe("const a = 42;\n"));
    expect(screen.getByLabelText("unsaved")).toBeInTheDocument();
  });

  it("reopens a closed tab from the tree", async () => {
    render(pane());
    await openFile();
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "a.ts" })).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "a.ts" }));
    expect(await screen.findByRole("tab", { name: "a.ts" })).toBeInTheDocument();
    expect((await editor()).value).toBe("const a = 1;\n");
  });
});

describe("FilesPane saving", () => {
  it("double ⌘S makes one write, and edits made meanwhile get one follow-up save", async () => {
    h.state.holdWrites = true;
    render(pane());
    const el = await openFile();
    type(el, "v1");
    pressSave(el);
    pressSave(el);
    await flush();
    expect(h.writeWorkspaceFile).toHaveBeenCalledTimes(1);

    type(el, "v2");
    pressSave(el);
    pressSave(el);
    await flush();
    expect(h.writeWorkspaceFile).toHaveBeenCalledTimes(1);

    await releaseWrite();
    await waitFor(() => expect(h.writeWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(h.writeWorkspaceFile).toHaveBeenLastCalledWith(WS, "a.ts", "v2", h.hashOf("v1"));
    await releaseWrite();

    await waitFor(() => expect(screen.getByText("saved")).toBeInTheDocument());
    expect(h.state.disk.get("a.ts")).toBe("v2");
    expect(h.showToast).not.toHaveBeenCalled();
    expect(diskBanner()).toBeNull();
  });

  it("does not flag its own save as a change on disk", async () => {
    h.state.holdWrites = true;
    render(pane());
    const el = await openFile();
    type(el, "v1");
    pressSave(el);
    await flush();
    expect(h.writeWorkspaceFile).toHaveBeenCalledTimes(1);
    // The user keeps typing while the save is in flight.
    type(el, "v1 and more");

    // The watcher sees our write land before the command's reply does.
    expect(h.state.disk.get("a.ts")).toBe("v1");
    let reads = h.readWorkspaceFile.mock.calls.length;
    await emitWorktreeChanged(["a.ts"]);
    await waitFor(() => expect(h.readWorkspaceFile.mock.calls.length).toBeGreaterThan(reads));
    await flush();
    expect(diskBanner()).toBeNull();

    // Then the reply, then the watcher again.
    await releaseWrite();
    await flush();
    reads = h.readWorkspaceFile.mock.calls.length;
    await emitWorktreeChanged(["a.ts"]);
    await waitFor(() => expect(h.readWorkspaceFile.mock.calls.length).toBeGreaterThan(reads));
    await flush();

    expect(diskBanner()).toBeNull();
    expect(el.value).toBe("v1 and more");
    expect(screen.getByText(/unsaved/)).toBeInTheDocument();
  });

  it("'Keep mine' saves the latest buffer, not the one from when the toast appeared", async () => {
    render(pane());
    const el = await openFile();
    type(el, "mine 1");
    // The agent writes meanwhile.
    h.state.disk.set("a.ts", "theirs");
    pressSave(el);
    await waitFor(() => expect(h.showToast).toHaveBeenCalled());
    expect(await screen.findByText(/changed this file on disk/)).toBeInTheDocument();

    type(el, "mine 2");
    const toast = h.showToast.mock.calls.at(-1)![0] as { action: { onClick: () => void } };
    await act(async () => toast.action.onClick());

    await waitFor(() => expect(h.state.disk.get("a.ts")).toBe("mine 2"));
    expect(h.writeWorkspaceFile).toHaveBeenLastCalledWith(WS, "a.ts", "mine 2", null);
  });
});

describe("FilesPane freshness", () => {
  it("refetches open files when the pane becomes visible again", async () => {
    const view = render(pane(true));
    const el = await openFile();
    view.rerender(pane(false));

    // The agent edits while the pane is hidden (no watcher subscription).
    h.state.disk.set("a.ts", "agent edit\n");
    view.rerender(pane(true));

    await waitFor(() => expect(el.value).toBe("agent edit\n"));
  });

  it("flags a hidden-time agent edit under unsaved changes when shown again", async () => {
    const view = render(pane(true));
    const el = await openFile();
    type(el, "mine");
    view.rerender(pane(false));

    h.state.disk.set("a.ts", "agent edit\n");
    view.rerender(pane(true));

    expect(await screen.findByText(/changed this file on disk/)).toBeInTheDocument();
    expect(el.value).toBe("mine");
  });
});

