CREATE TABLE assignment_runs (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'failed', 'auth-required')),
  student_count INTEGER NOT NULL CHECK(student_count >= 0),
  content_hash TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id)
) STRICT;
CREATE TABLE assignment_sections (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  student_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upcoming', 'missing', 'past')),
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'failed', 'auth-required')),
  PRIMARY KEY(account_id, run_id, student_key, kind),
  FOREIGN KEY(account_id, run_id) REFERENCES assignment_runs(account_id, run_id)
) STRICT;
CREATE TABLE assignment_observations (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  student_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  assignment_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  due_date TEXT,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id, student_key, kind, assignment_key),
  FOREIGN KEY(account_id, run_id, student_key, kind)
    REFERENCES assignment_sections(account_id, run_id, student_key, kind)
) STRICT;
CREATE INDEX assignment_identity ON assignment_observations(account_id, student_key, assignment_key, observed_at);
CREATE INDEX assignment_run_history ON assignment_runs(account_id, captured_at);
CREATE TABLE assignment_import_events (
  event_id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  FOREIGN KEY(account_id, run_id) REFERENCES assignment_runs(account_id, run_id)
) STRICT;
CREATE TRIGGER assignment_audit_no_update BEFORE UPDATE ON assignment_import_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;
CREATE TRIGGER assignment_audit_no_delete BEFORE DELETE ON assignment_import_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;