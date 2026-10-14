-- Store only the user's selectable deployment intent so an expired or
-- restarted preview can be freshly checked. Decisions and preview facts stay
-- in the short-lived payload and are never replayed from this request.
ALTER TABLE deployment_preview_snapshots
    ADD COLUMN request_json TEXT;

CREATE INDEX idx_deployment_preview_recent_requests
    ON deployment_preview_snapshots(status, created_at DESC)
    WHERE request_json IS NOT NULL;
