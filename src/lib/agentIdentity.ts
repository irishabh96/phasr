import { AGENT_ICON_DATA_URIS } from "@/lib/agentIcons";

/** Agents that ship a brand glyph + an identity color. */
export type AgentKey = keyof typeof AGENT_ICON_DATA_URIS;

/**
 * Per-agent identity color for author glyphs (comment avatars, etc.). Mirrors
 * the agent-color derivation in `WorkspaceAgentToolbar`, but expressed as
 * theme-aware design tokens (each already AA-tuned for both themes) rather than
 * the toolbar's raw brand hexes — those white/near-white brand marks (codex,
 * copilot) vanish on the light-theme surface. Deliberately NON-status hues:
 * an author's identity must never read as a status signal (honest status stays
 * the loud channel). Coral for Claude is its actual brand; the rest take
 * distinct, legible hues.
 */
export const AGENT_GLYPH_COLOR: Record<AgentKey, string> = {
  claude: "var(--color-accent-text)",
  codex: "var(--color-text-secondary)",
  copilot: "var(--color-text-muted)",
  gemini: "var(--color-info)",
  opencode: "var(--color-purple)",
};

/** The brand glyph data-URI for a known agent (undefined for unknown/human). */
export function agentGlyph(key: AgentKey): string {
  return AGENT_ICON_DATA_URIS[key];
}

/**
 * Resolve a free-form author name (e.g. a comment's `author`) to a known agent
 * key, or `null` when it isn't one of the recognized agents.
 */
export function agentKeyFromName(name: string): AgentKey | null {
  const key = name.trim().toLowerCase();
  return key in AGENT_ICON_DATA_URIS ? (key as AgentKey) : null;
}
