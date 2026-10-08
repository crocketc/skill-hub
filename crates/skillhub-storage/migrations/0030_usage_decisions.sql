CREATE TABLE usage_decisions (
    decision_id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL,
    directory_id TEXT NOT NULL CHECK (length(trim(directory_id)) > 0),
    relative_entry_path TEXT NOT NULL CHECK (length(trim(relative_entry_path)) > 0),
    relation_ids_json TEXT NOT NULL CHECK (json_valid(relation_ids_json)),
    physical_source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(physical_source_ids_json)),
    decision TEXT NOT NULL CHECK (decision IN ('released', 'retained_independent_copy')),
    content_fingerprint TEXT,
    decided_at INTEGER NOT NULL,
    operation_id TEXT,
    legacy_evidence INTEGER NOT NULL DEFAULT 0 CHECK (legacy_evidence IN (0, 1))
);

CREATE UNIQUE INDEX idx_usage_decisions_operation_slot
    ON usage_decisions(operation_id, skill_id, directory_id, relative_entry_path)
    WHERE operation_id IS NOT NULL AND legacy_evidence=0;
CREATE INDEX idx_usage_decisions_entry
    ON usage_decisions(skill_id, directory_id, relative_entry_path, decided_at, decision_id);

CREATE TABLE active_usage_slots (
    skill_id TEXT NOT NULL,
    directory_id TEXT NOT NULL CHECK (length(trim(directory_id)) > 0),
    relative_entry_path TEXT NOT NULL CHECK (length(trim(relative_entry_path)) > 0),
    PRIMARY KEY (skill_id, directory_id, relative_entry_path),
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE TABLE active_usage_evidence (
    skill_id TEXT NOT NULL,
    directory_id TEXT NOT NULL,
    relative_entry_path TEXT NOT NULL,
    relation_kind TEXT NOT NULL CHECK (relation_kind IN ('deployment', 'source_copy')),
    relation_id TEXT NOT NULL,
    physical_source_id TEXT,
    content_fingerprint TEXT,
    PRIMARY KEY (skill_id, directory_id, relative_entry_path, relation_kind, relation_id),
    UNIQUE (relation_kind, relation_id),
    FOREIGN KEY (skill_id, directory_id, relative_entry_path)
        REFERENCES active_usage_slots(skill_id, directory_id, relative_entry_path)
        ON DELETE CASCADE
);

CREATE INDEX idx_active_usage_evidence_entry
    ON active_usage_evidence(skill_id, directory_id, relative_entry_path);
