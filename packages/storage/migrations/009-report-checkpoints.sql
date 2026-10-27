CREATE TABLE report_checkpoints (
  scope_hash TEXT PRIMARY KEY,
  payload BLOB NOT NULL
) STRICT;
