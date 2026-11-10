import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToolItem, TranscriptItem } from "@/lib/transcript/contract";
import { linkTarget, Markdown, MarkdownLinkContext, parseBlocks } from "./Markdown";
import {
  TranscriptActionsContext,
  TranscriptChildrenContext,
  TranscriptFocusContext,
  TranscriptItemView,
  type TranscriptFocus,
} from "./TranscriptItem";

const ts = new Date(2026, 10, 11, 10, 42, 3).toISOString();
const show = (item: TranscriptItem) => render(<TranscriptItemView item={item} />).container;
const lines = (root: ParentNode, kind: string) =>
  Array.from(root.querySelectorAll(`[data-diff-line="${kind}"]`)).map((e) => e.textContent);

describe("transcript items", () => {
  it("stamps each row with local HH:MM:SS", () => {
    show({ kind: "user", id: "u", ts, text: "Fix it" });
    expect(screen.getByText("10:42:03").tagName).toBe("TIME");
    expect(screen.getByText("Fix it")).toBeInTheDocument();
  });

  it("splits the composer's attachment block off a user message", () => {
    show({ kind: "user", id: "u", ts, text: "Look at this\n\nAttached files:\n- src/a.ts\n- /tmp/shot.png" });
    expect(screen.getByText("Look at this")).toBeInTheDocument();
    const files = screen.getByRole("list", { name: "Attached files" });
    expect(files).toHaveTextContent("src/a.ts");
    expect(files).toHaveTextContent("/tmp/shot.png");
  });

  it("renders assistant markdown, with a caret only while streaming", () => {
    const { container, rerender } = render(
      <TranscriptItemView item={{ kind: "assistant", id: "a", ts, text: "Use `buildLoginUrl` **now**", streaming: true }} />,
    );
    expect(screen.getByText("buildLoginUrl").tagName).toBe("CODE");
    expect(screen.getByText("now").tagName).toBe("STRONG");
    expect(container.querySelector("[data-streaming-caret]")).not.toBeNull();
    rerender(<TranscriptItemView item={{ kind: "assistant", id: "a", ts, text: "Use `buildLoginUrl` **now**", streaming: false }} />);
    expect(container.querySelector("[data-streaming-caret]")).toBeNull();
  });

  it("collapses thinking to 'Thought for Ns' until expanded", () => {
    show({ kind: "thinking", id: "th", ts, text: "The cookie refresh drops the query.", durationMs: 4000 });
    const toggle = screen.getByRole("button", { name: /Thought for 4s/ });
    expect(screen.queryByText("The cookie refresh drops the query.")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("The cookie refresh drops the query.")).toBeInTheDocument();
  });

  it("shows thinking without a summary as a plain line, not a control", () => {
    const { container } = render(<TranscriptItemView item={{ kind: "thinking", id: "th", ts, text: "", durationMs: 1200 }} />);
    expect(screen.getByText("Thought for 1s")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("[data-thinking-empty]")).not.toBeNull();
    // Whitespace isn't a summary either.
    render(<TranscriptItemView item={{ kind: "thinking", id: "th2", ts, text: "\n\n" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("marks a tool line running, done, failed or denied", () => {
    const base = { kind: "tool" as const, id: "t", ts, tool: "Read", input: {}, title: "Reading src/a.ts" };
    const { rerender } = render(<TranscriptItemView item={{ ...base, status: "running" }} />);
    expect(screen.getByRole("img", { name: "running" })).toBeInTheDocument();
    rerender(<TranscriptItemView item={{ ...base, status: "done" }} />);
    expect(screen.getByRole("img", { name: "done" })).toHaveTextContent("✓");
    rerender(<TranscriptItemView item={{ ...base, status: "error", output: "ENOENT: no such file" }} />);
    expect(screen.getByRole("img", { name: "failed" })).toHaveTextContent("✗");
    // A failed compact tool says why.
    expect(screen.getByText("ENOENT: no such file")).toBeInTheDocument();
    rerender(<TranscriptItemView item={{ ...base, status: "denied" }} />);
    expect(screen.getByText("denied")).toBeInTheDocument();
    // The object of the verb is drawn brighter.
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  });

  it("shows an Edit's −/+ diff and its counts", () => {
    const root = show({
      kind: "tool",
      id: "e",
      ts,
      tool: "Edit",
      input: { file_path: "a.ts", old_string: "a\nold\nb", new_string: "a\nnew\nb" },
      title: "Editing a.ts",
      status: "done",
    });
    expect(lines(root, "remove")).toEqual(["-old"]);
    expect(lines(root, "add")).toEqual(["+new"]);
    expect(lines(root, "context")).toEqual([" a", " b"]);
    expect(root).toHaveTextContent("+1 −1");
  });

  it("caps a new file's preview and expands it", () => {
    const content = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const root = show({ kind: "tool", id: "w", ts, tool: "Write", input: { file_path: "a.ts", content }, title: "Writing a.ts", status: "done" });
    expect(lines(root, "add")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Show 24 more lines" }));
    expect(lines(root, "add")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(lines(root, "add")).toHaveLength(6);
  });

  it("shows a Bash command's output tail, expandable to all of it", () => {
    const output = Array.from({ length: 20 }, (_, i) => `out ${i + 1}`).join("\n");
    show({ kind: "tool", id: "b", ts, tool: "Bash", input: { command: "pnpm test" }, title: "Running pnpm test", status: "done", output });
    expect(screen.queryByText("out 8")).toBeNull();
    expect(screen.getByText("out 9")).toBeInTheDocument();
    expect(screen.getByText("out 20")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 lines" }));
    expect(screen.getByText("out 1")).toBeInTheDocument();
  });

  it("says when output was truncated", () => {
    show({ kind: "tool", id: "b", ts, tool: "Bash", input: {}, title: "Running x", status: "done", output: "a", outputTruncated: true });
    expect(screen.getByText(/output truncated/)).toBeInTheDocument();
  });

  it("keeps an unknown tool's output behind a toggle", () => {
    show({ kind: "tool", id: "g", ts, tool: "mcp__linear__get", input: { id: 1 }, title: "Calling linear", status: "done", output: "PHA-1" });
    expect(screen.queryByText("PHA-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "output" }));
    expect(screen.getByText("PHA-1")).toBeInTheDocument();
  });

  describe("a subagent call", () => {
    const agent = (extra: Partial<ToolItem> = {}): ToolItem => ({
      kind: "tool",
      id: "agent",
      ts,
      tool: "Agent",
      input: { description: "List repo files", subagent_type: "general-purpose", prompt: "…" },
      title: "Running a subagent: List repo files",
      status: "running",
      subagent: { type: "general-purpose", description: "List repo files", steps: 2, latest: "Reading src/a.ts" },
      ...extra,
    });
    const nested: TranscriptItem[] = [
      { kind: "tool", id: "n1", ts, tool: "Bash", input: { command: "ls" }, title: "Running ls", status: "done", output: "src", parentId: "agent" },
      { kind: "thinking", id: "n2", ts, text: "Now the file.", parentId: "agent" },
      { kind: "tool", id: "n3", ts, tool: "Read", input: {}, title: "Reading src/a.ts", status: "running", parentId: "agent" },
    ];

    it("shows what it was asked, its type, live activity and steps — collapsed", () => {
      const { container } = render(<TranscriptItemView item={agent()} nested={nested} />);
      const row = container.querySelector('[data-tool="Agent"]')!;
      expect(row).toHaveAttribute("data-subagent", "general-purpose");
      expect(row).toHaveTextContent("Subagent List repo files · general-purpose");
      expect(screen.getByRole("img", { name: "running" })).toBeInTheDocument();
      expect(container.querySelector("[data-subagent-latest]")).toHaveTextContent("Reading src/a.ts…");
      const toggle = screen.getByRole("button", { name: /2 steps/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(container.querySelector("[data-subagent-transcript]")).toBeNull();
      expect(screen.queryByText("Running ls")).toBeNull();
    });

    it("expands to its own transcript, indented, with the same renderers and no time column", () => {
      const { container } = render(<TranscriptItemView item={agent()} nested={nested} />);
      fireEvent.click(screen.getByRole("button", { name: /2 steps/ }));
      const group = screen.getByRole("group", { name: "Subagent: List repo files" });
      expect(group.querySelectorAll("[data-transcript-item]")).toHaveLength(3);
      expect(group.querySelector('[data-tool="Bash"]')).toHaveTextContent("Running ls");
      expect(group.querySelector("[data-output-tail]")).toHaveTextContent("src");
      expect(group.querySelectorAll("time")).toHaveLength(0);
      expect(container.querySelectorAll("time")).toHaveLength(1);
      // Its thinking has a summary: expandable.
      fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
      expect(screen.getByText("Now the file.")).toBeInTheDocument();
    });

    it("once done: no live line, the step count stays, its report is behind a toggle", () => {
      render(
        <TranscriptItemView
          item={agent({ status: "done", output: "The repo has **three** files." })}
          nested={nested}
        />,
      );
      expect(screen.queryByText(/Reading src\/a\.ts…/)).toBeNull();
      expect(screen.getByRole("button", { name: /2 steps/ })).toBeInTheDocument();
      expect(screen.queryByText("three")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "report" }));
      expect(screen.getByText("three").tagName).toBe("STRONG");
    });

    it("nests a subagent's own subagents through the children context", () => {
      const inner: ToolItem = { ...agent({ id: "inner", parentId: "agent" }), subagent: { type: "Explore", description: "Dig", steps: 1 } };
      const deep: TranscriptItem = { kind: "assistant", id: "deep", ts, text: "found it", streaming: false, parentId: "inner" };
      const map = new Map<string, readonly TranscriptItem[]>([["inner", [deep]]]);
      render(
        <TranscriptChildrenContext.Provider value={(id) => map.get(id)}>
          <TranscriptItemView item={agent()} nested={[inner]} />
        </TranscriptChildrenContext.Provider>,
      );
      fireEvent.click(screen.getByRole("button", { name: /2 steps/ }));
      fireEvent.click(screen.getByRole("button", { name: /1 step$/ }));
      expect(screen.getByRole("group", { name: "Subagent: Dig" })).toHaveTextContent("found it");
    });

    describe("in a transcript with a subagent panel", () => {
      const withPanel = (openSubagent: (id: string) => void, selectedSubagent: string | null = null) =>
        render(
          <TranscriptActionsContext.Provider value={{ openSubagent, selectedSubagent }}>
            <TranscriptItemView item={agent({ status: "done", output: "All **done**." })} nested={nested} />
          </TranscriptActionsContext.Provider>,
        );

      it("its title and its row open the panel; the steps chevron expands it inline", () => {
        const open = vi.fn();
        const { container } = withPanel(open);
        fireEvent.click(screen.getByRole("button", { name: /Subagent List repo files/ }));
        expect(open).toHaveBeenLastCalledWith("agent");
        expect(container.querySelector("[data-subagent-transcript]")).toBeNull();
        // Anywhere else on the row: the panel too.
        open.mockClear();
        fireEvent.click(container.querySelector('[data-tool="Agent"]')!);
        expect(open).toHaveBeenCalledWith("agent");
        // The chevron: inline, not the panel.
        open.mockClear();
        fireEvent.click(screen.getByRole("button", { name: /2 steps/ }));
        expect(open).not.toHaveBeenCalled();
        const group = screen.getByRole("group", { name: "Subagent: List repo files" });
        // Clicks inside the expanded group or the report are theirs.
        fireEvent.click(group.querySelector('[data-tool="Bash"]')!);
        fireEvent.click(screen.getByRole("button", { name: "report" }));
        fireEvent.click(screen.getByText("done"));
        expect(open).not.toHaveBeenCalled();
      });

      it("reads as selected while the panel shows it", () => {
        const { container } = withPanel(vi.fn(), "agent");
        expect(container.querySelector('[data-tool="Agent"]')).toHaveAttribute("data-selected", "true");
        expect(screen.getByRole("button", { name: /Subagent List repo files/ })).toHaveAttribute("aria-current", "true");
      });

      it("a reveal without expand highlights the row but leaves it collapsed", () => {
        const { container } = render(
          <TranscriptActionsContext.Provider value={{ openSubagent: vi.fn() }}>
            <TranscriptFocusContext.Provider value={{ itemId: "agent", open: new Set(), nonce: 3, expand: false }}>
              <TranscriptItemView item={agent()} nested={nested} />
            </TranscriptFocusContext.Provider>
          </TranscriptActionsContext.Provider>,
        );
        expect(container.querySelector('[data-tool="Agent"]')!.className).toMatch(/bg-\(--color-bg-hover\)/);
        expect(container.querySelector("[data-subagent-transcript]")).toBeNull();
      });
    });
  });

  describe("a background command", () => {
    const bg = (extra: Partial<ToolItem> = {}): ToolItem => ({
      kind: "tool",
      id: "bg",
      ts,
      tool: "Bash",
      input: { command: "pnpm dev", run_in_background: true },
      title: "Running pnpm dev",
      status: "done",
      background: true,
      backgroundStatus: "running",
      ...extra,
    });

    it("says it runs in the background, live, with its output collapsed", () => {
      const { container } = render(<TranscriptItemView item={bg({ output: "ready on :1420\nGET /" })} />);
      const row = container.querySelector('[data-tool="Bash"]')!;
      expect(row).toHaveAttribute("data-background-status", "running");
      expect(screen.getByRole("img", { name: "running in background" })).toBeInTheDocument();
      expect(row).toHaveTextContent(/in background · \d+(s|m)/);
      // The call's own ✓ isn't shown: the command is what's running.
      expect(screen.queryByRole("img", { name: "done" })).toBeNull();
      expect(screen.queryByText("ready on :1420")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "output · 2 lines" }));
      expect(screen.getByText("ready on :1420")).toBeInTheDocument();
    });

    it("ends finished, stopped or failed", () => {
      const { rerender } = render(<TranscriptItemView item={bg({ backgroundStatus: "done" })} />);
      expect(screen.getByText("finished in background")).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "done" })).toBeInTheDocument();
      rerender(<TranscriptItemView item={bg({ backgroundStatus: "killed" })} />);
      expect(screen.getByText("stopped")).toBeInTheDocument();
      rerender(<TranscriptItemView item={bg({ backgroundStatus: "failed" })} />);
      expect(screen.getByRole("img", { name: "failed" })).toBeInTheDocument();
    });

    it("opens its output, and the subagent groups around it, when a chip asks", () => {
      const inside: ToolItem = bg({ id: "bg-in", parentId: "agent", output: "watching…" });
      const map = new Map<string, readonly TranscriptItem[]>([["agent", [inside]]]);
      const parent: ToolItem = {
        kind: "tool",
        id: "agent",
        ts,
        tool: "Agent",
        input: {},
        title: "Running a subagent: Watch",
        status: "running",
        subagent: { type: "general-purpose", description: "Watch", steps: 1 },
      };
      const view = (focus: TranscriptFocus | null) => (
        <TranscriptChildrenContext.Provider value={(id) => map.get(id)}>
          <TranscriptFocusContext.Provider value={focus}>
            <TranscriptItemView item={parent} nested={[inside]} />
          </TranscriptFocusContext.Provider>
        </TranscriptChildrenContext.Provider>
      );
      const { rerender } = render(view(null));
      expect(screen.queryByText("watching…")).toBeNull();
      rerender(view({ itemId: "bg-in", open: new Set(["agent"]), nonce: 1, expand: true }));
      expect(screen.getByRole("group", { name: "Subagent: Watch" })).toBeInTheDocument();
      expect(screen.getByText("watching…")).toBeInTheDocument();
    });
  });

  it("renders the quiet result line and system lines", () => {
    show({ kind: "result", id: "r", ts, durationMs: 23_000, costUsd: 0.04, isError: false });
    expect(screen.getByText("Done in 23s · $0.04")).toBeInTheDocument();
    show({ kind: "system", id: "s", ts, level: "error", text: "Claude exited (1)" });
    expect(screen.getByRole("alert")).toHaveTextContent("Claude exited (1)");
  });
});

describe("markdown blocks", () => {
  it("parses paragraphs, headings, lists, quotes, rules and fences", () => {
    const blocks = parseBlocks("# Plan\n\nFirst line\nsecond\n\n- a\n  more\n- b\n\n1. one\n\n> note\n\n---\n\n```ts\nconst x = 1;\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["h", "p", "list", "list", "quote", "hr", "code"]);
    expect(blocks[2]).toMatchObject({ items: [{ text: "a more" }, { text: "b" }] });
    expect(blocks[6]).toMatchObject({ lang: "ts", text: "const x = 1;" });
  });

  it("renders an unclosed fence (still streaming) as code so far", () => {
    expect(parseBlocks("Here:\n```\nnpm i")).toEqual([
      { kind: "p", lines: ["Here:"] },
      { kind: "code", lang: "", text: "npm i", closed: false },
    ]);
  });

  it("parses a GFM table: alignment, escaped and code pipes, ragged rows", () => {
    const blocks = parseBlocks(
      "Scores:\n| Area | Score | Why |\n|:---|:---:|---:|\n| **Security** | 1/10 | keys in `a|b` and a\\|b |\n| Tests | 0/10 |\n\nAfter.",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table", "p"]);
    expect(blocks[1]).toEqual({
      kind: "table",
      align: ["left", "center", "right"],
      header: ["Area", "Score", "Why"],
      rows: [
        ["**Security**", "1/10", "keys in `a|b` and a\\|b"],
        ["Tests", "0/10", ""],
      ],
    });
  });

  it("does not take a lone pipe line, or a mismatched delimiter, for a table", () => {
    expect(parseBlocks("a | b\nnext").map((b) => b.kind)).toEqual(["p"]);
    expect(parseBlocks("| a | b |\n|---|").map((b) => b.kind)).toEqual(["p"]);
  });

  it("keeps a fence inside a list item as code, and the list after it", () => {
    const blocks = parseBlocks("1. Run:\n   ```bash\n   npm i\n   ```\n2. Then build");
    expect(blocks.map((b) => b.kind)).toEqual(["list", "code", "list"]);
    expect(blocks[1]).toMatchObject({ lang: "bash", text: "npm i", closed: true });
    expect(blocks[2]).toMatchObject({ items: [{ marker: "2.", text: "Then build" }] });
  });

  it("parses task list items", () => {
    expect(parseBlocks("- [x] done\n- [ ] todo\n- plain")[0]).toMatchObject({
      items: [
        { text: "done", task: true },
        { text: "todo", task: false },
        { text: "plain", task: null },
      ],
    });
  });

  it("marks a closed mermaid fence so it can be drawn", () => {
    expect(parseBlocks("```mermaid\ngraph TD; A-->B\n```")[0]).toMatchObject({ lang: "mermaid", closed: true });
  });
});

describe("markdown links", () => {
  const root = "/Users/me/.phasr/worktrees/t1";
  it("classifies web, file and other targets", () => {
    expect(linkTarget("https://example.com/a_(b)")).toEqual({ kind: "web", href: "https://example.com/a_(b)" });
    expect(linkTarget("src/env.js", root)).toEqual({ kind: "file", path: "src/env.js", line: undefined });
    expect(linkTarget("./src/a.ts:42", root)).toEqual({ kind: "file", path: "src/a.ts", line: 42 });
    expect(linkTarget("src/a.ts#L7-L9", root)).toEqual({ kind: "file", path: "src/a.ts", line: 7 });
    expect(linkTarget(`${root}/src/My%20File.ts`, root)).toEqual({ kind: "file", path: "src/My File.ts", line: undefined });
    expect(linkTarget(`file://${root}/x.md`, root)).toEqual({ kind: "file", path: "x.md", line: undefined });
    // Nothing outside the worktree, no traversal, no other schemes.
    expect(linkTarget("/etc/passwd", root)).toEqual({ kind: "none" });
    expect(linkTarget("../secrets", root)).toEqual({ kind: "none" });
    expect(linkTarget("javascript:alert(1)", root)).toEqual({ kind: "none" });
    expect(linkTarget("mailto:a@b.c", root)).toEqual({ kind: "none" });
    expect(linkTarget("#section", root)).toEqual({ kind: "none" });
  });

  const html = (md: string, links = {}) =>
    render(
      <MarkdownLinkContext.Provider value={links}>
        <Markdown text={md} />
      </MarkdownLinkContext.Provider>,
    ).container;

  it("renders web links, autolinks and bare URLs as anchors, trimming trailing punctuation", () => {
    const c = html("See [docs](https://a.dev/x), <https://b.dev> and https://c.dev/p?q=1. Done");
    expect([...c.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://a.dev/x",
      "https://b.dev",
      "https://c.dev/p?q=1",
    ]);
  });

  it("opens file links in the Files pane and never renders other schemes as links", () => {
    const openFile = vi.fn();
    const c = html("Edit [`env.js`](src/env.js:12) not [x](javascript:alert(1)) or [y](/etc/hosts)", { root, openFile });
    const buttons = c.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(openFile).toHaveBeenCalledWith("src/env.js", 12);
    expect(c.querySelectorAll("a")).toHaveLength(0);
  });

  it("renders inline extras: strike, bold-italic, escapes, <br>, images as links", () => {
    const c = html("~~old~~ ***both*** \\*not italic\\* a<br>b ![chart](https://x.dev/c.png)");
    expect(c.querySelector("s")?.textContent).toBe("old");
    expect(c.querySelector("strong em")?.textContent).toBe("both");
    expect(c.textContent).toContain("*not italic*");
    expect(c.querySelectorAll("p br")).toHaveLength(1);
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("a")?.textContent).toBe("chart");
  });

  it("renders a table with header cells and inline formatting in cells", () => {
    const c = html("| Area | Score |\n|---|--:|\n| **Security** | `1|10` |");
    expect([...c.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Area", "Score"]);
    const cells = c.querySelectorAll("td");
    expect(cells[0]!.querySelector("strong")?.textContent).toBe("Security");
    expect(cells[1]!.textContent).toBe("1|10");
    expect((cells[1] as HTMLElement).style.textAlign).toBe("right");
  });
});
