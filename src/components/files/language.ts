/**
 * File → language label for the editor status line. Deliberately free of
 * CodeMirror imports: FileEditor is in the session chunk, and CodeMirror
 * must load only when the editor itself does (CodeEditor is lazy()).
 */
const LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  md: "Markdown",
  mdx: "Markdown",
  rs: "Rust",
  py: "Python",
};

export function languageLabel(path: string): string {
  return LABELS[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "Plain text";
}
