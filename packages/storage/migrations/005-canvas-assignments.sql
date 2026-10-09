CREATE TABLE canvas_assignment_runs (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'failed', 'auth-required')),
  student_count INTEGER NOT NULL CHECK(student_count >= 0),
  content_hash TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id)
) STRICT;
CREATE TABLE canvas_assignment_courses (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  student_key TEXT NOT NULL,
  course_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'failed', 'auth-required')),
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id, student_key, course_key),
  FOREIGN KEY(account_id, run_id) REFERENCES canvas_assignment_runs(account_id, run_id)
) STRICT;
CREATE TABLE canvas_assignment_observations (
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  student_key TEXT NOT NULL,
  course_key TEXT NOT NULL,
  assignment_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, run_id, student_key, course_key, assignment_key),
  FOREIGN KEY(account_id, run_id, student_key, course_key) REFERENCES canvas_assignment_courses(account_id, run_id, student_key, course_key)
) STRICT;
CREATE INDEX canvas_assignment_identity ON canvas_assignment_observations(account_id, student_key, course_key, assignment_key, observed_at);
CREATE INDEX canvas_run_history ON canvas_assignment_runs(account_id, captured_at);
CREATE TABLE canvas_course_mappings (
  account_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, mapping_id),
  UNIQUE(account_id, scope_key)
) STRICT;
CREATE TABLE canvas_assignment_links (
  account_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  canvas_key TEXT NOT NULL,
  skyward_account_id TEXT NOT NULL,
  skyward_key TEXT NOT NULL,
  canvas_run_id TEXT NOT NULL,
  skyward_run_id TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, link_id),
  UNIQUE(account_id, canvas_key),
  UNIQUE(skyward_account_id, skyward_key),
  FOREIGN KEY(account_id, mapping_id) REFERENCES canvas_course_mappings(account_id, mapping_id),
  FOREIGN KEY(account_id, canvas_run_id) REFERENCES canvas_assignment_runs(account_id, run_id),
  FOREIGN KEY(skyward_account_id, skyward_run_id) REFERENCES assignment_runs(account_id, run_id)
) STRICT;
CREATE TABLE canvas_audit_events (
  event_id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('import-run', 'confirm-course', 'confirm-assignment')),
  reference_id TEXT NOT NULL
) STRICT;
CREATE TRIGGER canvas_audit_no_update BEFORE UPDATE ON canvas_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;
CREATE TRIGGER canvas_audit_no_delete BEFORE DELETE ON canvas_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;