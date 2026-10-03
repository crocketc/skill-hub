-- Idempotency receipts for explicit relationship-governance mutations.
-- The request revision is retained so reusing an operation ID with a changed
-- payload can be rejected; this table is independent of live relationship
-- rows so retries remain recognizable after an end operation.
CREATE TABLE relationship_governance_mutation_receipts (
    operation_id TEXT PRIMARY KEY,
    -- The request ID proves payload identity; the representative ID keeps the
    -- replay result stable when the caller addressed merged evidence.
    relation_id TEXT NOT NULL,
    representative_relation_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('revoke_retention', 'end_relationship')),
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
    result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
    occurred_at INTEGER NOT NULL
);
