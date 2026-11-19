-- Distinguish a job waiting in the queue from a real sign-in attempt.
ALTER TABLE pilot_check_jobs ADD COLUMN attempted_at TEXT;
UPDATE pilot_check_jobs SET attempted_at = created_at WHERE lease_hash IS NOT NULL;
