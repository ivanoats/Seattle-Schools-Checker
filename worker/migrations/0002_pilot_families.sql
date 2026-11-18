-- Pilot identity is verified by Access; membership is enforced by the app.
CREATE TABLE pilot_families (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE pilot_invites (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES pilot_families(id),
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_by TEXT
);
CREATE TABLE pilot_members (
  subject TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES pilot_families(id),
  email TEXT NOT NULL,
  selected_child_id TEXT,
  created_at TEXT NOT NULL
);
-- Only a trusted provider-discovery adapter may populate these rows.
-- Browser clients cannot invent a provider-to-child mapping.
CREATE TABLE pilot_children (
  family_id TEXT NOT NULL REFERENCES pilot_families(id),
  id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (family_id, id)
);
