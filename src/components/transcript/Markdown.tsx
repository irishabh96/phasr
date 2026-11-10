import { Fragment, memo, type ReactNode } from "react";

/**
 * The markdown an agent writes, rendered as React elements (never HTML
 * strings): paragraphs, headings, lists, quotes, fenced code, rules, and
 * inline `code`, **bold**, *italic* and [links](https://…).
 *
 * The app has no markdown dependency and the notes render plain text, so
 * this is deliberately small. Anything it doesn't know stays literal text,
 * and an unclosed fence (a reply still streaming) renders as code so far.
 */

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: { indent: number; marker: string; text: string }[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

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
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(close)) body.push(lines[i++]!);
      i++; // the closing fence (or past the end while streaming)
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
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
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: { indent: number; marker: string; text: string }[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (m) {
          items.push({ indent: Math.floor(m[1]!.replace(/\t/g, "  ").length / 2), marker: m[2]!, text: m[3]! });
          i++;
          continue;
        }
        // A lazy continuation line belongs to the item above it.
        const cont = lines[i]!;
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
      !HR.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_]*?)_(?![\w_])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Inline spans. Exported for tests. */
export function renderInline(text: string, keyPrefix = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}${n++}`;
    if (m[2] !== undefined) {
      out.push(
        <code key={key} className="text-(--color-text-primary)">
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(
        <strong key={key} className="font-semibold text-(--color-text-primary)">
          {renderInline(m[3] ?? m[4]!, `${key}.`)}
        </strong>,
      );
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push(
        <em key={key} className="italic">
          {renderInline(m[5] ?? m[6]!, `${key}.`)}
        </em>,
      );
    } else if (m[7] !== undefined && m[8] !== undefined) {
      out.push(
        <a
          key={key}
          href={m[8]}
          className="text-(--color-text-primary) underline decoration-(--color-text-faint) underline-offset-2 hover:decoration-(--color-text-secondary)"
        >
          {renderInline(m[7], `${key}.`)}
        </a>,
      );
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
                <pre className="m-0 overflow-x-auto whitespace-pre rounded-(--radius-control) bg-(--color-bg-input) px-[12px] py-[8px] font-mono text-(--color-text-primary)">
                  {b.text}
                </pre>
                {tail}
              </div>
            );
          case "list":
            return (
              <ul key={i} className="m-0 flex list-none flex-col p-0">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-[8px]" style={{ paddingLeft: it.indent * 16 }}>
                    <span aria-hidden className="shrink-0 text-(--color-text-muted)">
                      {b.ordered ? it.marker : "•"}
                    </span>
                    <span className="min-w-0">
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
