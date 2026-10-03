-- Keep the last explicit management decision separate from current health
-- observations. Scans can update relationship health without erasing a prior
-- successful takeover confirmation.
CREATE TABLE relation_governance_confirmations (
    relation_id TEXT PRIMARY KEY,
    management_status TEXT NOT NULL
        CHECK (management_status IN ('not_taken_over', 'taken_over')),
    decision TEXT NOT NULL
        CHECK (decision IN ('undecided', 'retained_independent_copy')),
    confirmed_at INTEGER
);

-- Only legacy facts that explicitly record a SkillHub-owned symbolic link or
-- junction prove a prior takeover. Active state and content verification are
-- health evidence and do not manufacture management history.
INSERT INTO relation_governance_confirmations (
    relation_id, management_status, decision, confirmed_at
)
SELECT relation_id, 'taken_over', 'undecided', observed_at
FROM deployment_relations
WHERE active = 1
  AND released_at IS NULL
  AND relationship = 'managed_link'
  AND ownership = 'skillhub_managed'
  AND file_representation IN ('symbolic_link', 'directory_junction');
