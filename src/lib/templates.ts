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
  {
    id: "t3",
    name: "Create-T3",
    description: "Full-stack TypeScript: Next.js, tRPC, Prisma, NextAuth.",
    gitUrl: "https://github.com/t3-oss/create-t3-app",
    tag: "T3",
  },
  {
    id: "tauri-react",
    name: "Tauri 2 + React",
    description: "Desktop app starter — what Phasr itself is built on.",
    gitUrl: "https://github.com/lapce/tauri-react-template",
    tag: "Tauri",
  },
];
