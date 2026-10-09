CREATE TABLE canvas_assignments (
  record_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  student_key TEXT NOT NULL,
  course_key TEXT NOT NULL,
  UNIQUE(account_id, record_id)
) STRICT;
INSERT INTO canvas_assignments
  SELECT DISTINCT assignment_key, account_id, student_key, course_key FROM canvas_assignment_observations;

CREATE UNIQUE INDEX canvas_link_identity ON canvas_assignment_links(account_id, link_id, skyward_account_id, skyward_key, canvas_key);
CREATE TABLE skyward_assignments (
  account_id TEXT NOT NULL,
  assignment_key TEXT NOT NULL,
  student_key TEXT NOT NULL,
  canvas_status TEXT NOT NULL DEFAULT 'pending' CHECK(canvas_status IN ('pending', 'unmatched', 'review-required', 'linked')),
  canvas_account_id TEXT,
  canvas_record_id TEXT UNIQUE,
  canvas_link_id TEXT,
  match_reason TEXT CHECK(match_reason IN ('ambiguous', 'date-conflict', 'undated', 'already-linked', 'source-incomplete', 'source-stale', 'not-observed', 'scope-conflict')),
  last_match_at TEXT,
  match_attempts INTEGER NOT NULL DEFAULT 0 CHECK(match_attempts >= 0),
  PRIMARY KEY(account_id, assignment_key),
  FOREIGN KEY(canvas_account_id, canvas_record_id) REFERENCES canvas_assignments(account_id, record_id),
  FOREIGN KEY(canvas_account_id, canvas_link_id, account_id, assignment_key, canvas_record_id)
    REFERENCES canvas_assignment_links(account_id, link_id, skyward_account_id, skyward_key, canvas_key),
  CHECK((canvas_status = 'linked' AND canvas_account_id IS NOT NULL AND canvas_record_id IS NOT NULL AND canvas_link_id IS NOT NULL AND match_reason IS NULL)
    OR (canvas_status <> 'linked' AND canvas_account_id IS NULL AND canvas_record_id IS NULL AND canvas_link_id IS NULL)),
  CHECK((canvas_status = 'review-required' AND match_reason IS NOT NULL) OR (canvas_status <> 'review-required' AND match_reason IS NULL))
) STRICT;
INSERT INTO skyward_assignments(account_id, assignment_key, student_key)
  SELECT DISTINCT account_id, assignment_key, student_key FROM assignment_observations;
UPDATE skyward_assignments SET
  canvas_status = 'linked',
  canvas_account_id = (SELECT account_id FROM canvas_assignment_links WHERE skyward_account_id = skyward_assignments.account_id AND skyward_key = assignment_key),
  canvas_record_id = (SELECT canvas_key FROM canvas_assignment_links WHERE skyward_account_id = skyward_assignments.account_id AND skyward_key = assignment_key),
  canvas_link_id = (SELECT link_id FROM canvas_assignment_links WHERE skyward_account_id = skyward_assignments.account_id AND skyward_key = assignment_key)
WHERE EXISTS (SELECT 1 FROM canvas_assignment_links WHERE skyward_account_id = skyward_assignments.account_id AND skyward_key = assignment_key);

CREATE TRIGGER skyward_assignment_identity AFTER INSERT ON assignment_observations
BEGIN
  INSERT INTO skyward_assignments(account_id, assignment_key, student_key)
    VALUES (NEW.account_id, NEW.assignment_key, NEW.student_key) ON CONFLICT(account_id, assignment_key) DO NOTHING;
END;
CREATE TRIGGER canvas_assignment_identity AFTER INSERT ON canvas_assignment_observations
BEGIN
  INSERT INTO canvas_assignments(record_id, account_id, student_key, course_key)
    VALUES (NEW.assignment_key, NEW.account_id, NEW.student_key, NEW.course_key) ON CONFLICT(record_id) DO NOTHING;
END;
CREATE TRIGGER canvas_link_requires_identity BEFORE INSERT ON canvas_assignment_links
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM canvas_assignments WHERE account_id = NEW.account_id AND record_id = NEW.canvas_key)
    OR NOT EXISTS (SELECT 1 FROM skyward_assignments WHERE account_id = NEW.skyward_account_id AND assignment_key = NEW.skyward_key)
    THEN RAISE(ABORT, 'Assignment identity is unavailable') END;
END;
CREATE TRIGGER canvas_link_status AFTER INSERT ON canvas_assignment_links
BEGIN
  UPDATE skyward_assignments SET canvas_status = 'linked', match_reason = NULL,
    canvas_account_id = NEW.account_id, canvas_record_id = NEW.canvas_key, canvas_link_id = NEW.link_id
    WHERE account_id = NEW.skyward_account_id AND assignment_key = NEW.skyward_key;
END;
CREATE TRIGGER skyward_canvas_link_immutable BEFORE UPDATE OF canvas_status, canvas_account_id, canvas_record_id, canvas_link_id ON skyward_assignments
WHEN OLD.canvas_status = 'linked' AND (NEW.canvas_status IS NOT OLD.canvas_status OR NEW.canvas_account_id IS NOT OLD.canvas_account_id
  OR NEW.canvas_record_id IS NOT OLD.canvas_record_id OR NEW.canvas_link_id IS NOT OLD.canvas_link_id)
BEGIN SELECT RAISE(ABORT, 'An existing assignment link cannot be reassigned'); END;

CREATE TABLE canvas_match_runs (
  account_id TEXT NOT NULL,
  match_run_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  lookback_days INTEGER NOT NULL CHECK(lookback_days BETWEEN 1 AND 366),
  payload BLOB NOT NULL,
  PRIMARY KEY(account_id, match_run_id)
) STRICT;
CREATE TRIGGER canvas_match_no_update BEFORE UPDATE ON canvas_match_runs
BEGIN SELECT RAISE(ABORT, 'Matching audit is append-only'); END;
CREATE TRIGGER canvas_match_no_delete BEFORE DELETE ON canvas_match_runs
BEGIN SELECT RAISE(ABORT, 'Matching audit is append-only'); END;