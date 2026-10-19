-- Local tombstone when history.list reports a deletion.
-- Sync never calls messages.delete, messages.modify, or labels.* on Gmail.

ALTER TABLE messages
  ADD COLUMN removed_at timestamptz;

COMMENT ON COLUMN messages.removed_at IS
  'Set from a history.list messagesDeleted record. This is a local flag; Gmail is not modified.';
