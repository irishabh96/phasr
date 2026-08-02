-- Phase 2 (completion program): the epic's terminal milestone becomes a fact,
-- not a derivation. `ship_epic` stamps `shipped_at` when the integration
-- branch lands cleanly on the default branch, so "Shipped" survives base
-- moving ahead (the old FE derivation `integrated && aheadOfTarget === 0`
-- silently un-shipped an epic the moment ANY later commit landed on main).
-- Nullable + additive; board rows never sync (0015 precedent), so this is
-- local-only state.
ALTER TABLE workspaces ADD COLUMN shipped_at TEXT NULL;
