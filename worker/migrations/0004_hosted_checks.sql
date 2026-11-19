-- Credentials stay on the versioned connection; jobs contain confirmed mappings only.
CREATE TABLE pilot_check_jobs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES pilot_connections(id),
  revision TEXT NOT NULL,
  slot TEXT NOT NULL,
  children TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  lease_hash TEXT,
  lease_expires_at TEXT,
  UNIQUE(connection_id, revision, slot)
);
CREATE INDEX pilot_checks_pending ON pilot_check_jobs(state, created_at);
