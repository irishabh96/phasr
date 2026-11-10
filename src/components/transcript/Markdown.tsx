import { createContext, Fragment, memo, useContext, type ReactNode } from "react";
import { MermaidDiagram } from "./MermaidDiagram";

/**
 * The markdown an agent writes, rendered as React elements (never HTML
 * strings): paragraphs, headings, lists (task lists, code inside items),
 * quotes, fenced code, mermaid diagrams, rules, GFM tables, and inline
 * `code`, **bold**, *italic*, ~~strike~~, links, autolinks, file links,
 * escapes and `<br>`.
 *
 * The app has no markdown dependency and the notes render plain text, so
 * this is deliberately small. Anything it doesn't know stays literal text,
 * and an unclosed fence (a reply still streaming) renders as code so far.
 */

type Align = "left" | "center" | "right" | null;
type ListItem = { indent: number; marker: string; text: string; task: boolean | null };

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string; closed: boolean }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; align: Align[]; header: string[]; rows: string[][] }
  | { kind: "hr" };

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
/** `|---|:--:|--:` — at least one column, pipes optional at the ends. */
const TABLE_DELIMITER = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * A row's cells: split on `|` except an escaped `\|` or one inside a
 * `code` span, with the optional outer pipes dropped. Exported for tests.
 */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let tick = 0; // length of the open backtick run, 0 outside code
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && line[i + 1] === "|") {
      cell += "\\|";
      i++;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      if (tick === 0) tick = run;
      else if (run === tick) tick = 0;
      cell += line.slice(i, i + run);
      i += run - 1;
      continue;
    }
    if (c === "|" && tick === 0) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += c;
  }
  cells.push(cell);
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|") && cells.length > 0) cells.pop();
  return cells.map((x) => x.trim());
}

/** A header row followed by a delimiter row with the same column count. */
function tableAt(lines: string[], i: number): Align[] | null {
  const header = lines[i];
  const delimiter = lines[i + 1];
  if (header === undefined || delimiter === undefined) return null;
  if (!header.includes("|") || !TABLE_DELIMITER.test(delimiter)) return null;
  const spec = splitRow(delimiter);
  if (spec.length !== splitRow(header).length) return null;
  return spec.map((d) => {
    const l = d.startsWith(":");
    const r = d.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
}

/** Exported for tests. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      // A fence may be indented (inside a list item); its body loses the
      // same indentation.
      const indent = fence[1]!.length;
      const close = fence[2]!;
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.trimStart().startsWith(close) && l.trim().replace(/[`~]/g, "") === "") {
          closed = true;
          break;
        }
        const lead = /^\s*/.exec(l)![0].length;
        body.push(l.slice(Math.min(lead, indent)));
        i++;
      }
      i++; // the closing fence (or past the end while streaming)
      blocks.push({ kind: "code", lang: fence[3] ?? "", text: body.join("\n"), closed });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    const align = tableAt(lines, i);
    if (align) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i++]!);
        // GFM: a short row is padded, a long one cut to the header.
        rows.push(header.map((_, c) => cells[c] ?? ""));
      }
      blocks.push({ kind: "table", align, header, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (m) {
          const task = TASK.exec(m[3]!);
          items.push({
            indent: Math.floor(m[1]!.replace(/\t/g, "  ").length / 2),
            marker: m[2]!,
            text: task ? m[3]!.slice(task[0].length) : m[3]!,
            task: task ? task[1] !== " " : null,
          });
          i++;
          continue;
        }
        const cont = lines[i]!;
        // A fence inside an item ends the run here; the code renders as
        // its own block and the list picks up again after it.
        if (FENCE.test(cont)) break;
        // A lazy continuation line belongs to the item above it.
        if (cont.trim() !== "" && /^\s+/.test(cont) && items.length > 0) {
          items[items.length - 1]!.text += ` ${cont.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !FENCE.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !QUOTE.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!) &&
      !HR.test(lines[i]!) &&
      !(para.length > 0 && tableAt(lines, i))
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

// ── Links ────────────────────────────────────────────────────────────────

/** How the transcript opens a file an agent linked to. */
export interface MarkdownLinks {
  /** The worktree root, for links written as absolute paths. */
  root?: string | null;
  openFile?: (path: string, line?: number) => void;
}

export const MarkdownLinkContext = createContext<MarkdownLinks>({});

export type LinkTarget =
  | { kind: "web"; href: string }
  | { kind: "file"; path: string; line?: number | undefined }
  | { kind: "none" };

/**
 * What a link points at. Only http(s) leaves the app (through the shell's
 * external-link opener); paths open in the Files pane; any other scheme
 * stays text — an agent's output never gets to navigate the app.
 * Exported for tests.
 */
export function linkTarget(raw: string, root?: string | null): LinkTarget {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return { kind: "web", href };
  if (href.startsWith("#")) return { kind: "none" };
  let path = href.replace(/^file:\/\//i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return { kind: "none" };
  let line: number | undefined;
  const anchor = /#L(\d+)(?:-L?\d+)?$/.exec(path);
  if (anchor) {
    line = Number(anchor[1]);
    path = path.slice(0, anchor.index);
  } else {
    const colon = /:(\d+)(?::\d+)?$/.exec(path);
    if (colon) {
      line = Number(colon[1]);
      path = path.slice(0, colon.index);
    }
  }
  try {
    path = decodeURI(path);
  } catch {
    /* keep it as written */
  }
  if (path.startsWith("/")) {
    const base = root?.replace(/\/+$/, "");
    if (!base || !path.startsWith(`${base}/`)) return { kind: "none" };
    path = path.slice(base.length + 1);
  }
  path = path.replace(/^\.\//, "");
  if (!path || path.split("/").includes("..")) return { kind: "none" };
  return { kind: "file", path, line };
}

const LINK_CLASS =
  "text-(--color-text-primary) underline decoration-(--color-text-faint) underline-offset-2 hover:decoration-(--color-text-secondary)";

function Link({ href, children }: { href: string; children: ReactNode }) {
  const links = useContext(MarkdownLinkContext);
  const target = linkTarget(href, links.root);
  if (target.kind === "web")
    return (
      <a href={target.href} title={target.href} className={LINK_CLASS}>
        {children}
      </a>
    );
  if (target.kind === "file" && links.openFile) {
    const label = target.line ? `${target.path}:${target.line}` : target.path;
    return (
      <button
        type="button"
        title={`Open ${label}`}
        onClick={() => links.openFile!(target.path, target.line)}
        className={`cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] ${LINK_CLASS}`}
      >
        {children}
      </button>
    );
  }
  return <span title={href}>{children}</span>;
}

// ── Inline ───────────────────────────────────────────────────────────────

const INLINE = new RegExp(
  [
    String.raw`\\(?<esc>[!-/:-@[-\x60{-~])`,
    String.raw`(?<tick>\x60+)(?<code>[\s\S]*?[^\x60])\k<tick>(?!\x60)`,
    String.raw`!\[(?<alt>[^\]]*)\]\((?<src>[^)\s]+)(?:\s+"[^"]*")?\)`,
    String.raw`\[(?<label>(?:[^[\]]|\[[^\]]*\])+)\]\((?<href>(?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)`,
    String.raw`<(?<auto>https?:\/\/[^\s>]+)>`,
    String.raw`(?<![\w/(\[<"'=])(?<bare>https?:\/\/[^\s<>"]*[^\s<>".,:;'!?)\]])`,
    String.raw`\*\*\*(?<bi>[^*]+?)\*\*\*`,
    String.raw`\*\*(?<b1>(?:[^*]|\*(?!\*))+?)\*\*`,
    String.raw`__(?<b2>[^_]+?)__`,
    String.raw`~~(?<s>[^~]+?)~~`,
    String.raw`(?<![\w*])\*(?<i1>[^*\s][^*]*?)\*(?![\w*])`,
    String.raw`(?<![\w_])_(?<i2>[^_\s][^_]*?)_(?![\w_])`,
    String.raw`(?<br><br\s*\/?>)`,
  ].join("|"),
  "gi",
);

/** Inline spans. Exported for tests. */
export function renderInline(text: string, keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}${n++}`;
    const g = m.groups!;
    if (g.esc !== undefined) {
      out.push(g.esc);
    } else if (g.code !== undefined) {
      out.push(
        <code key={key} className="text-(--color-text-primary)">
          {/* A table cell writes a literal pipe as `\|`, even in code. */}
          {g.code.replace(/\\\|/g, "|")}
        </code>,
      );
    } else if (g.src !== undefined) {
      // No remote image loads from agent output: the alt text, linked.
      out.push(
        <Link key={key} href={g.src}>
          {g.alt || g.src}
        </Link>,
      );
    } else if (g.href !== undefined) {
      out.push(
        <Link key={key} href={g.href}>
          {renderInline(g.label!, `${key}.`)}
        </Link>,
      );
    } else if (g.auto !== undefined || g.bare !== undefined) {
      const url = (g.auto ?? g.bare)!;
      out.push(
        <Link key={key} href={url}>
          {url}
        </Link>,
      );
    } else if (g.bi !== undefined) {
      out.push(
        <strong key={key} className="font-semibold text-(--color-text-primary)">
          <em className="italic">{renderInline(g.bi, `${key}.`)}</em>
        </strong>,
      );
    } else if (g.b1 !== undefined || g.b2 !== undefined) {
      out.push(
        <strong key={key} className="font-semibold text-(--color-text-primary)">
          {renderInline((g.b1 ?? g.b2)!, `${key}.`)}
        </strong>,
      );
    } else if (g.s !== undefined) {
      out.push(
        <s key={key} className="text-(--color-text-muted)">
          {renderInline(g.s, `${key}.`)}
        </s>,
      );
    } else if (g.i1 !== undefined || g.i2 !== undefined) {
      out.push(
        <em key={key} className="italic">
          {renderInline((g.i1 ?? g.i2)!, `${key}.`)}
        </em>,
      );
    } else if (g.br !== undefined) {
      out.push(<br key={key} />);
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(ls: string[], key: string): ReactNode[] {
  return ls.map((l, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 ? <br /> : null}
      {renderInline(l, `${key}-${i}-`)}
    </Fragment>
  ));
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="m-0 overflow-x-auto whitespace-pre rounded-(--radius-control) bg-(--color-bg-input) px-[12px] py-[8px] font-mono text-(--color-text-primary)">
      {text}
    </pre>
  );
}

/** Rendered markdown; `trailing` (the streaming caret) follows the last block. */
export const Markdown = memo(function Markdown({ text, trailing }: { text: string; trailing?: ReactNode }) {
  const blocks = parseBlocks(text);
  const last = blocks.length - 1;
  return (
    <div className="flex flex-col gap-[6px]">
      {blocks.map((b, i) => {
        const tail = i === last ? trailing : null;
        switch (b.kind) {
          case "p":
            return (
              <p key={i} className="m-0">
                {lines(b.lines, String(i))}
                {tail}
              </p>
            );
          case "h":
            return (
              <p key={i} className="m-0 font-semibold text-(--color-text-primary)">
                {renderInline(b.text, `${i}-`)}
                {tail}
              </p>
            );
          case "hr":
            return <hr key={i} className="my-[4px] h-px border-0 bg-(--color-border-subtle)" />;
          case "quote":
            return (
              <blockquote key={i} className="m-0 border-l-2 border-(--color-border-default) pl-[10px] text-(--color-text-secondary)">
                {lines(b.lines, String(i))}
                {tail}
              </blockquote>
            );
          case "code":
            return (
              <div key={i}>
                {b.lang.toLowerCase() === "mermaid" && b.closed ? (
                  <MermaidDiagram source={b.text} fallback={<CodeBlock text={b.text} />} />
                ) : (
                  <CodeBlock text={b.text} />
                )}
                {tail}
              </div>
            );
          case "table":
            return (
              <div key={i}>
                <div className="overflow-x-auto">
                  <table className="border-collapse text-left">
                    <thead>
                      <tr className="border-b border-(--color-border-default)">
                        {b.header.map((cell, c) => (
                          <th
                            key={c}
                            scope="col"
                            className="px-[12px] py-[4px] align-bottom font-semibold whitespace-nowrap text-(--color-text-primary) first:pl-0"
                            style={{ textAlign: b.align[c] ?? undefined }}
                          >
                            {renderInline(cell, `${i}-h${c}-`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {b.rows.map((row, r) => (
                        <tr key={r} className="border-b border-(--color-border-subtle) last:border-b-0">
                          {row.map((cell, c) => (
                            <td
                              key={c}
                              className="px-[12px] py-[6px] align-top first:pl-0"
                              style={{ textAlign: b.align[c] ?? undefined }}
                            >
                              {renderInline(cell, `${i}-${r}-${c}-`)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {tail}
              </div>
            );
          case "list":
            return (
              <ul key={i} className="m-0 flex list-none flex-col p-0">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-[8px]" style={{ paddingLeft: it.indent * 16 }}>
                    {it.task === null ? (
                      <span aria-hidden className="shrink-0 text-(--color-text-muted)">
                        {b.ordered ? it.marker : "•"}
                      </span>
                    ) : (
                      <span
                        role="img"
                        aria-label={it.task ? "Done" : "Not done"}
                        className={it.task ? "shrink-0 text-(--color-success)" : "shrink-0 text-(--color-text-muted)"}
                      >
                        {it.task ? "☑" : "☐"}
                      </span>
                    )}
                    <span className={it.task ? "min-w-0 text-(--color-text-secondary)" : "min-w-0"}>
                      {renderInline(it.text, `${i}-${j}-`)}
                      {j === b.items.length - 1 ? tail : null}
                    </span>
                  </li>
                ))}
              </ul>
            );
        }
      })}
      {blocks.length === 0 ? trailing : null}
    </div>
  );
});
