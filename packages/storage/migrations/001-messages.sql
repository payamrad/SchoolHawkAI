CREATE TABLE storage_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE collection_runs (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  portal_id TEXT NOT NULL CHECK(portal_id = 'skyward'),
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'failed')),
  selection TEXT NOT NULL CHECK(selection IN ('all', 'unread')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  message_count INTEGER NOT NULL CHECK(message_count >= 0),
  scanned_count INTEGER NOT NULL CHECK(scanned_count >= 0),
  content_hash TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id)
) STRICT;
CREATE TABLE message_observations (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  sent_date TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id, message_id),
  UNIQUE(account_id, run_id, ordinal),
  FOREIGN KEY(account_id, run_id) REFERENCES collection_runs(account_id, run_id)
) STRICT;
CREATE INDEX observations_identity ON message_observations(account_id, message_id, observed_at);
CREATE INDEX runs_history ON collection_runs(account_id, captured_at);
CREATE TABLE audit_events (
  event_id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action = 'import-run'),
  FOREIGN KEY(account_id, run_id) REFERENCES collection_runs(account_id, run_id)
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;