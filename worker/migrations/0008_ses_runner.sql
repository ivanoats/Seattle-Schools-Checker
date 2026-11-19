ALTER TABLE pilot_report_deliveries ADD COLUMN lease_hash TEXT;
ALTER TABLE pilot_report_deliveries ADD COLUMN lease_expires_at TEXT;
ALTER TABLE pilot_report_deliveries ADD COLUMN mapping_signature TEXT;
-- Operator-created, expiring transport tests contain no school data.
CREATE TABLE pilot_report_email_tests (
 id TEXT PRIMARY KEY,
 recipient TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','sending','sent','failed','unknown','skipped')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 lease_hash TEXT,
 lease_expires_at TEXT,
 message_id TEXT
);
