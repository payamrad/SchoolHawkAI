ALTER TABLE collection_runs ADD COLUMN removed_message_count INTEGER NOT NULL DEFAULT 0 CHECK(removed_message_count >= 0);
CREATE TABLE cleanup_events (
  event_id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target = 'LoginNotification'),
  message_count INTEGER NOT NULL CHECK(message_count >= 0),
  observation_count INTEGER NOT NULL CHECK(observation_count >= 0),
  run_count INTEGER NOT NULL CHECK(run_count >= 0)
) STRICT;
CREATE TRIGGER cleanup_no_update BEFORE UPDATE ON cleanup_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;
CREATE TRIGGER cleanup_no_delete BEFORE DELETE ON cleanup_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;