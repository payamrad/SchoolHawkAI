CREATE TABLE review_profiles (
  profile_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL
) STRICT;

CREATE TABLE review_events (
  profile_id TEXT NOT NULL REFERENCES review_profiles(profile_id),
  event_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(profile_id, event_id)
) STRICT;
CREATE INDEX review_event_time ON review_events(profile_id, detected_at, event_id);

CREATE TABLE review_evaluations (
  profile_id TEXT NOT NULL REFERENCES review_profiles(profile_id),
  evaluation_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY(profile_id, evaluation_id)
) STRICT;
CREATE INDEX review_evaluation_time ON review_evaluations(profile_id, evaluated_at, evaluation_id);

CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events
BEGIN SELECT RAISE(ABORT, 'Review events are append-only'); END;
CREATE TRIGGER review_events_no_delete BEFORE DELETE ON review_events
BEGIN SELECT RAISE(ABORT, 'Review events are append-only'); END;
CREATE TRIGGER review_evaluations_no_update BEFORE UPDATE ON review_evaluations
BEGIN SELECT RAISE(ABORT, 'Review evaluations are append-only'); END;
CREATE TRIGGER review_evaluations_no_delete BEFORE DELETE ON review_evaluations
BEGIN SELECT RAISE(ABORT, 'Review evaluations are append-only'); END;
