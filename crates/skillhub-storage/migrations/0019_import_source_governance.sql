-- Immutable evidence has no live-entity cascade: deleting a Skill must not
-- erase the import record or the display snapshots used by history.
CREATE TABLE import_batches (
    batch_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE TABLE import_provenance_events_v19 (
    provenance_id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL,
    directory_node_id TEXT,
    agent_client_id TEXT,
    source_path TEXT NOT NULL,
    source_path_key TEXT NOT NULL,
    relationship TEXT NOT NULL,
    file_representation TEXT NOT NULL,
    ownership TEXT NOT NULL,
    link_target_path TEXT,
    link_target_directory_id TEXT,
    content_fingerprint TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_locator TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    batch_id TEXT NOT NULL REFERENCES import_batches(batch_id),
    source_class TEXT NOT NULL CHECK(source_class IN ('agent_local','user_local','registered_project','online','central_library','legacy_unclassified')),
    local_source_path TEXT,
    source_container_id TEXT,
    physical_source_id TEXT,
    CHECK(source_class <> 'online' OR (local_source_path IS NULL AND physical_source_id IS NULL))
);
INSERT INTO import_batches(batch_id,status,started_at,finished_at)
SELECT 'legacy:' || provenance_id,'completed',imported_at,imported_at FROM source_relations;
INSERT INTO import_provenance_events_v19 (
    provenance_id,skill_id,directory_node_id,agent_client_id,source_path,source_path_key,
    relationship,file_representation,ownership,link_target_path,link_target_directory_id,
    content_fingerprint,source_kind,source_locator,imported_at,batch_id,source_class,local_source_path
)
SELECT provenance_id,skill_id,directory_node_id,agent_client_id,source_path,source_path_key,
    relationship,file_representation,ownership,link_target_path,link_target_directory_id,
    content_fingerprint,source_kind,source_locator,imported_at,'legacy:' || provenance_id,
    'legacy_unclassified',source_path FROM source_relations;

CREATE TABLE conflict_case_members_v19 (
    member_id TEXT PRIMARY KEY NOT NULL,
    conflict_id TEXT NOT NULL REFERENCES conflict_cases(conflict_id) ON DELETE CASCADE,
    skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
    version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
    provenance_id TEXT REFERENCES import_provenance_events_v19(provenance_id),
    directory_node_id TEXT REFERENCES directory_nodes(node_id) ON DELETE SET NULL,
    path TEXT,
    fingerprint TEXT
);
INSERT INTO conflict_case_members_v19(member_id,conflict_id,skill_id,version_id,provenance_id,directory_node_id,path,fingerprint)
SELECT member_id,conflict_id,skill_id,version_id,provenance_id,directory_node_id,path,fingerprint FROM conflict_case_members;
DROP TABLE conflict_case_members;
ALTER TABLE conflict_case_members_v19 RENAME TO conflict_case_members;
CREATE INDEX idx_conflict_case_members_case ON conflict_case_members(conflict_id);
CREATE INDEX idx_conflict_case_members_provenance ON conflict_case_members(provenance_id);
DROP INDEX idx_source_relations_skill;
DROP INDEX idx_source_relations_path;
DROP TABLE source_relations;
CREATE INDEX idx_import_events_skill ON import_provenance_events_v19(skill_id,imported_at,provenance_id);
CREATE INDEX idx_import_events_path ON import_provenance_events_v19(source_path_key);
CREATE INDEX idx_import_events_batch ON import_provenance_events_v19(batch_id);
-- Read-only compatibility alias; every repository write targets the new table.
CREATE VIEW source_relations AS SELECT provenance_id,skill_id,directory_node_id,agent_client_id,
    source_path,source_path_key,relationship,file_representation,ownership,link_target_path,
    link_target_directory_id,content_fingerprint,source_kind,source_locator,imported_at
    FROM import_provenance_events_v19;
CREATE TRIGGER import_events_no_update BEFORE UPDATE ON import_provenance_events_v19
BEGIN SELECT RAISE(ABORT,'import provenance events are immutable'); END;
CREATE TRIGGER import_events_no_delete BEFORE DELETE ON import_provenance_events_v19
BEGIN SELECT RAISE(ABORT,'import provenance events are immutable'); END;
-- Deprecated latest-only projection retained for existing callers.
ALTER TABLE import_provenance ADD COLUMN deprecated_projection INTEGER NOT NULL DEFAULT 1 CHECK(deprecated_projection=1);

CREATE TABLE source_copy_relations (
    relation_id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id),
    latest_provenance_id TEXT NOT NULL REFERENCES import_provenance_events_v19(provenance_id),
    physical_source_id TEXT NOT NULL CHECK(length(trim(physical_source_id))>0),
    identity_algorithm TEXT NOT NULL CHECK(length(trim(identity_algorithm))>0),
    identity_version INTEGER NOT NULL CHECK(identity_version>0),
    source_path_key TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    fact_json TEXT NOT NULL CHECK(json_valid(fact_json))
);
CREATE UNIQUE INDEX idx_source_copy_active_physical ON source_copy_relations(physical_source_id) WHERE active=1;
CREATE UNIQUE INDEX idx_source_copy_active_skill_path ON source_copy_relations(skill_id,source_path_key) WHERE active=1;
CREATE INDEX idx_source_copy_skill ON source_copy_relations(skill_id,active);
CREATE TABLE import_batch_items (
    batch_id TEXT NOT NULL REFERENCES import_batches(batch_id),
    candidate_key TEXT NOT NULL,
    skill_id TEXT,
    provenance_id TEXT REFERENCES import_provenance_events_v19(provenance_id),
    source_relation_id TEXT REFERENCES source_copy_relations(relation_id),
    status TEXT NOT NULL CHECK(status IN ('succeeded','failed','cancelled','skipped')),
    reason TEXT,
    PRIMARY KEY(batch_id,candidate_key)
);
INSERT INTO import_batch_items(batch_id,candidate_key,skill_id,provenance_id,status)
SELECT batch_id,provenance_id,skill_id,provenance_id,'succeeded' FROM import_provenance_events_v19;
CREATE INDEX idx_import_batch_items_relation ON import_batch_items(source_relation_id);
-- Legacy migration rows remain unlinked: matching a spelling is not proof of
-- physical source identity. A later verified backfill may associate them.
ALTER TABLE original_migrations ADD COLUMN source_relation_id TEXT REFERENCES source_copy_relations(relation_id);
CREATE TABLE relation_history_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    relation_id TEXT NOT NULL,
    skill_id TEXT,
    skill_display_name TEXT NOT NULL,
    agent_presentation_json TEXT NOT NULL CHECK(json_valid(agent_presentation_json)),
    path TEXT NOT NULL,
    scope TEXT NOT NULL,
    project_id TEXT,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    reason TEXT,
    operation_id TEXT,
    occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_relation_history_scope_time ON relation_history_events(scope,occurred_at DESC,event_id);
CREATE INDEX idx_relation_history_time ON relation_history_events(occurred_at DESC,event_id);
CREATE INDEX idx_relation_history_skill ON relation_history_events(skill_id,occurred_at DESC,event_id);
CREATE INDEX idx_relation_history_relation ON relation_history_events(relation_id,occurred_at DESC,event_id);
CREATE TRIGGER relation_history_no_update BEFORE UPDATE ON relation_history_events
BEGIN SELECT RAISE(ABORT,'relationship history is immutable'); END;
CREATE TRIGGER relation_history_no_delete BEFORE DELETE ON relation_history_events
BEGIN SELECT RAISE(ABORT,'relationship history is immutable'); END;
