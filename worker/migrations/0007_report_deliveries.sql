-- A day is final once an email may have left the Worker. No raw email bodies,
-- recipient copies or school records are duplicated into delivery history.
CREATE TABLE pilot_report_deliveries (
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  check_date TEXT NOT NULL,
  recipient_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('waiting','sending','retry','sent','failed','unknown','skipped')),
  cutoff TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT,
  message_id TEXT,
  reason TEXT,
  PRIMARY KEY(family_id,child_id,check_date),
  FOREIGN KEY(family_id,child_id) REFERENCES pilot_children(family_id,id)
);
CREATE INDEX pilot_report_delivery_state ON pilot_report_deliveries(state,updated_at);
