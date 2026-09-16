-- One monotonic revision invalidates relationship projections without creating
-- a second relationship fact store.
CREATE TABLE relationship_projection_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    last_verified_at INTEGER
);

INSERT INTO relationship_projection_state (id, revision, last_verified_at)
VALUES (1, 0, NULL);
