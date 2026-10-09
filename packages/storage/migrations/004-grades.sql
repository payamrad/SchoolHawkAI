CREATE TABLE grade_runs (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'failed', 'auth-required')),
  student_count INTEGER NOT NULL CHECK(student_count >= 0),
  content_hash TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id)
) STRICT;
CREATE TABLE grade_students (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  student_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'failed', 'auth-required')),
  PRIMARY KEY(account_id, run_id, student_key),
  FOREIGN KEY(account_id, run_id) REFERENCES grade_runs(account_id, run_id)
) STRICT;
CREATE TABLE grade_observations (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  student_key TEXT NOT NULL,
  grade_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id, student_key, grade_key),
  FOREIGN KEY(account_id, run_id, student_key) REFERENCES grade_students(account_id, run_id, student_key)
) STRICT;
CREATE INDEX grade_identity ON grade_observations(account_id, student_key, grade_key, observed_at);
CREATE INDEX grade_run_history ON grade_runs(account_id, captured_at);
CREATE TABLE grade_import_events (
  event_id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  FOREIGN KEY(account_id, run_id) REFERENCES grade_runs(account_id, run_id)
) STRICT;
CREATE TRIGGER grade_audit_no_update BEFORE UPDATE ON grade_import_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;
CREATE TRIGGER grade_audit_no_delete BEFORE DELETE ON grade_import_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;