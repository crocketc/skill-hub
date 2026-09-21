-- Persist the latest explicit upstream observation so list queries can filter
-- without performing network work during rendering.
CREATE TABLE source_update_checks (
    skill_id TEXT PRIMARY KEY NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    upstream_label TEXT,
    checked_at INTEGER NOT NULL
);

