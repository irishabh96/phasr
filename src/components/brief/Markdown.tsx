import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { cn } from "@/lib/utils";

/**
 * Read-first brief markdown (spec D1) — the security-sensitive surface (both
 * human- AND agent-authored text with full IPC-bridge access), so it is locked
 * down per Architect Stage-1 #4:
 *
 *  - **No raw HTML.** react-markdown ignores raw HTML by default (we never add
 *    `rehype-raw`), so `<img onerror=…>` / `<script>` render as inert text.
 *  - **rehype-sanitize** with the strict default schema strips anything unsafe
 *    that slips through and constrains link/image protocols — `javascript:` and
 *    (for links) `data:` are dropped; images are http/https only.
 *  - **External links open via the shell plugin** (`openUrl`), never in-webview,
 *    so a link can never navigate the app frame away from the IPC bridge.
 *
 * Edit mode is a plain `GlassTextarea` (no live preview in v1); this component
 * renders read mode only.
 */

// The strict default schema already blocks javascript:/data: on href and limits
// img src to http/https. We keep it verbatim (the safest baseline) rather than
// widening it.
const schema = defaultSchema;

function ExternalLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        // Open in the user's browser via the shell plugin, never in-webview.
        e.preventDefault();
        if (href) void openUrl(href).catch(() => {});
      }}
      className="text-(--color-accent-text) underline decoration-(--color-border-strong) underline-offset-2 hover:decoration-(--color-accent-text)"
    >
      {children}
    </a>
  );
}

const components: Components = {
  a: ExternalLink,
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-3 text-[14px] font-semibold text-(--color-text-primary) first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-[13.5px] font-semibold text-(--color-text-primary) first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold text-(--color-text-primary) first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-2.5 text-[13px] font-semibold text-(--color-text-primary) first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc pl-[18px] last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal pl-[18px] last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold text-(--color-text-primary)">
      {children}
    </strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className: c, children }) => {
    const isBlock = /language-/.test(c ?? "");
    if (isBlock) {
      return (
        <code className="font-mono text-[11.5px] text-(--color-text-primary)">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded-[5px] border border-(--glass-border-hairline) bg-(--color-bg-input) px-[5px] py-px font-mono text-[11.5px] text-(--color-text-primary)">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-[8px] border border-(--glass-border-hairline) bg-(--color-bg-input) p-2.5 last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-(--color-border-strong) pl-3 text-(--color-text-muted)">
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr className="my-3 border-0 border-t border-(--color-border-subtle)" />
  ),
  // GFM tables. remark-gfm emits bare <table>/<th>/<td>; without these they
  // render as unstyled, border-less text with cells colliding. A collapsed
  // hairline grid keeps a dense-but-legible table that reads as structure.
  table: ({ children }) => (
    <table className="my-3 w-full border-collapse text-[12px]">
      {children}
    </table>
  ),
  th: ({ children }) => (
    <th className="border border-(--glass-border-hairline) bg-(--color-bg-input) px-2.5 py-1.5 text-left align-top font-semibold text-(--color-text-primary)">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-(--glass-border-hairline) px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
};

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      data-testid="brief-markdown"
      className={cn(
        // `break-words` so a long unbreakable token (a URL, an inline
        // `identifier_with_no_spaces`, a code fence label) wraps inside the
        // reading column instead of clipping past the right edge.
        "text-[12.5px] leading-relaxed break-words text-(--color-text-secondary)",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
