-- Custom agents have been removed from the product surface. Purge old
-- cloud rows so workspaces fall back to their command snapshots.

DELETE FROM public.agents;
