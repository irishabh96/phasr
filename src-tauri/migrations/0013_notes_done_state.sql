-- Notes become todos: any note can be checked off.
--
-- `done_at` carries BOTH facts in one column — whether the note is done
-- (NOT NULL) and when it was marked (the sort key for the done list).
-- A separate boolean would let the two disagree; this can't.
--
-- Sort contract, straight from the product requirement:
--   open  → WHERE done_at IS NULL     ORDER BY created_at DESC, id DESC
--   done  → WHERE done_at IS NOT NULL ORDER BY done_at    DESC, id DESC
--
-- Toggling done does NOT touch updated_at: that drives the "edited"
-- badge, and checking a box is not an edit of the note's text.

ALTER TABLE repository_notes ADD COLUMN done_at TEXT;

-- Partial indexes matching the two queries above, so each population is
-- served without scanning the other.
CREATE INDEX idx_repository_notes_open
    ON repository_notes(repository_id, created_at DESC)
    WHERE deleted_at IS NULL AND done_at IS NULL;

CREATE INDEX idx_repository_notes_done
    ON repository_notes(repository_id, done_at DESC)
    WHERE deleted_at IS NULL AND done_at IS NOT NULL;
