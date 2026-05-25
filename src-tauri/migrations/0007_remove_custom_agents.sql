-- Custom agents have been removed from the product surface. Keep the
-- agents table for built-in seed rows and local command/default
-- overrides, but purge any old user-created rows.

DELETE FROM agents WHERE is_seed = 0;
