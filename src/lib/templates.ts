export interface Template {
  id: string;
  name: string;
  description: string;
  gitUrl: string;
  /** Short tag shown in the corner of the card, e.g. "Next.js". */
  tag?: string;
}

/**
 * Hardcoded starter templates for the New Project wizard.
 *
 * Each template is cloned with `--depth 1`, then its `.git` is removed
 * and the project is re-initialised so the user owns commit 0. See
 * `src-tauri/src/git/template.rs` for the exact steps.
 *
 * Adding a template: append an entry here, point `gitUrl` at a public
 * repo whose root IS the starter (subdir templates aren't supported in
 * v1).
 */
export const TEMPLATES: Template[] = [
  {
    id: "next-shadcn",
    name: "Next.js + shadcn/ui",
    description: "App Router, Tailwind v4, shadcn primitives.",
    gitUrl: "https://github.com/shadcn-ui/next-template",
    tag: "Next.js",
  },
  {
    id: "astro-blog",
    name: "Astro Paper blog",
    description: "Markdown + MDX blog starter with light/dark mode.",
    gitUrl: "https://github.com/satnaing/astro-paper",
    tag: "Astro",
  },
];
// NOTE: these gitUrls must be VERIFIED public repos whose ROOT is the starter
// (subdir templates aren't supported). Removed `lapce/tauri-react-template`
// (404 — never existed). `t3-oss/create-t3-app` is the create-t3 CLI monorepo,
// NOT a T3 app starter — cloning its root gives the CLI source; recheck/replace
// with a real app starter (or a `create-*` CLI flow) when curating this list.
