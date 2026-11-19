CREATE TABLE pilot_connections (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES pilot_families(id),
  provider TEXT NOT NULL CHECK (provider IN ('source', 'schoology')),
  revision TEXT NOT NULL,
  credentials TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'discovering', 'ready', 'attention', 'disconnected')),
  reason TEXT,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (family_id, provider)
);
CREATE TABLE pilot_discovery_jobs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES pilot_connections(id),
  revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  lease_hash TEXT,
  lease_expires_at TEXT
);
CREATE INDEX pilot_discovery_pending ON pilot_discovery_jobs (state, created_at);
CREATE TABLE pilot_candidates (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES pilot_connections(id),
  revision TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mapping TEXT NOT NULL,
  UNIQUE (connection_id, revision, remote_id)
);
CREATE TABLE pilot_child_providers (
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('source', 'schoology')),
  connection_id TEXT NOT NULL REFERENCES pilot_connections(id),
  revision TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  mapping TEXT NOT NULL,
  PRIMARY KEY (family_id, child_id, provider),
  UNIQUE (connection_id, revision, remote_id),
  FOREIGN KEY (family_id, child_id) REFERENCES pilot_children(family_id, id)
);
