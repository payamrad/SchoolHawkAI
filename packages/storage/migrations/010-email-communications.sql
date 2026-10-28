CREATE TABLE email_communications (
  scope_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('report', 'no-change')),
  accepted_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (scope_hash, kind)
) STRICT;
