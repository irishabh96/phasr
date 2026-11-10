/**
 * Prompt attachments: files the user hands the agent with a prompt or a
 * composer message. They live in the draft's local state only (never
 * persisted) and reach the agent as plain text, a list of paths appended to
 * the message, so it works the same for every agent CLI.
 */
export interface Attachment {
  /** Absolute path on disk. */
  path: string;
  /** What the chip shows: the file name. */
  name: string;
  kind: "image" | "file";
  /** Bytes, when known (pasted images). Picked files don't report it. */
  size?: number;
  /**
   * An in-memory `blob:` URL for a pasted image's thumbnail. Picked files
   * have none: the asset protocol is off, so the webview can't read disk.
   */
  previewUrl?: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?|avif)$/i;

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function attachmentFromPath(path: string): Attachment {
  return { path, name: baseName(path) || path, kind: IMAGE_EXT.test(path) ? "image" : "file" };
}

/** `path` relative to the most specific root that contains it, else null. */
export function relativeTo(path: string, roots: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const raw of roots) {
    if (!raw) continue;
    const root = raw.replace(/\/+$/, "");
    if (!root || !path.startsWith(`${root}/`)) continue;
    if (root.length > bestLen) {
      best = path.slice(root.length + 1);
      bestLen = root.length;
    }
  }
  return best;
}

/**
 * The block appended to a message:
 *
 *     Attached files:
 *     - src/app.ts
 *     - /Users/me/Desktop/shot.png
 *
 * A file inside one of `roots` (the task's worktree or repository) is
 * written relative to it, so it reads as the agent's own file; anything
 * else stays absolute. Empty when there's nothing attached.
 */
export function formatAttachmentBlock(
  attachments: readonly Pick<Attachment, "path">[],
  roots: readonly (string | null | undefined)[] = [],
): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => `- ${relativeTo(a.path, roots) ?? a.path}`);
  return ["Attached files:", ...lines].join("\n");
}

/** `text` with the attachment block after a blank line (or alone). */
export function withAttachmentBlock(
  text: string,
  attachments: readonly Pick<Attachment, "path">[],
  roots: readonly (string | null | undefined)[] = [],
): string {
  const block = formatAttachmentBlock(attachments, roots);
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}

/** A task name from the first attachment: "login-error.png" → "login-error". */
export function nameFromAttachments(attachments: readonly Attachment[]): string {
  const first = attachments[0];
  if (!first) return "";
  const stem = first.name.replace(/\.[^.]+$/, "") || first.name;
  return stem.trim().toLowerCase();
}

/** Pasted-image MIME types the backend accepts, and the extension it gets. */
export const PASTE_IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
