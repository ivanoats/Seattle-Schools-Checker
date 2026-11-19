-- Recipient lists belong to a confirmed child inside the authenticated family.
-- Editing this list does not grant application access or send a message.
CREATE TABLE pilot_report_recipients (
  family_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  recipients TEXT NOT NULL CHECK (json_valid(recipients) AND json_type(recipients) = 'array'),
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (family_id, child_id),
  FOREIGN KEY (family_id, child_id) REFERENCES pilot_children(family_id, id)
);
