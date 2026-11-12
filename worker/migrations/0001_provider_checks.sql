-- One row per run, child and provider. Rows are never updated.
-- A failed check is its own row, so it cannot replace a verified observation.
CREATE TABLE provider_checks (
  run_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('source', 'schoology')),
  runner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'unavailable')),
  reason TEXT,
  attempted_at TEXT NOT NULL,
  observed_at TEXT,
  observation TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (run_id, child_id, provider),
  CHECK (
    (status = 'ok' AND observation IS NOT NULL AND observed_at IS NOT NULL AND reason IS NULL)
    OR (status = 'unavailable' AND observation IS NULL AND observed_at IS NULL AND reason IS NOT NULL)
  )
);

CREATE INDEX provider_checks_latest
  ON provider_checks (family_id, child_id, provider, attempted_at DESC);
