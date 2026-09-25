-- Task 13B: short-term server-owned deployment preview snapshots.
-- A preview commit must reference a snapshot the backend still holds; the
-- payload lets an unexpired snapshot be revalidated after a restart, the
-- status marks a snapshot as consumed by its first commit, and the commit
-- table records idempotent replay results.
CREATE TABLE deployment_preview_snapshots (
    preview_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'consumed')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX idx_deployment_preview_active
    ON deployment_preview_snapshots(status, expires_at);

CREATE TABLE deployment_preview_commits (
    idempotency_key TEXT PRIMARY KEY,
    preview_id TEXT NOT NULL REFERENCES deployment_preview_snapshots(preview_id),
    result_json TEXT NOT NULL,
    committed_at INTEGER NOT NULL
);
