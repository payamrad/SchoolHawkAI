CREATE TABLE agent_reports (
  report_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  received_at TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  student_count INTEGER NOT NULL CHECK(student_count >= 0 AND student_count <= 2000),
  payload BLOB NOT NULL
) STRICT;
CREATE INDEX agent_report_time ON agent_reports(received_at DESC, report_id DESC);

CREATE TRIGGER agent_reports_no_update BEFORE UPDATE ON agent_reports
BEGIN SELECT RAISE(ABORT, 'AI reports are append-only'); END;
CREATE TRIGGER agent_reports_no_delete BEFORE DELETE ON agent_reports
BEGIN SELECT RAISE(ABORT, 'AI reports are append-only'); END;
