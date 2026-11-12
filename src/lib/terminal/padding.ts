import type { CSSProperties } from "react";

/**
 * Text inset of every terminal (agent, shell tabs, run commands). The
 * terminal fills its pane edge to edge on the terminal black; this padding
 * is the only space between the pane's edges and the text, placing it close
 * to A-Workspace's transcript. The grid is measured inside it, so changing
 * it changes rows/cols, nothing else.
 */
export const TERMINAL_PADDING: CSSProperties = {
  paddingTop: 12,
  paddingRight: 16,
  paddingBottom: 8,
  paddingLeft: 16,
};
