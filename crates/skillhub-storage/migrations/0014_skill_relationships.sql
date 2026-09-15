-- Normalized relationship facts.  The 0013 tables remain intact as legacy
-- compatibility projections; these tables use independent fact identities.

CREATE TABLE directory_nodes (
    node_id TEXT PRIMARY KEY NOT NULL,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('central_library', 'agent_native', 'shared_directory', 'project')),
    profile_id TEXT,
    agent_client_id TEXT,
    exists_flag INTEGER NOT NULL CHECK (exists_flag IN (0, 1)),
    observed_at INTEGER NOT NULL,
    scan_source TEXT
);

CREATE TABLE agent_directory_capabilities (
    agent_client_id TEXT NOT NULL,
    directory_node_id TEXT NOT NULL REFERENCES directory_nodes(node_id) ON DELETE CASCADE,
    recognition TEXT NOT NULL CHECK (recognition IN ('supported', 'unknown', 'unsupported')),
    precedence TEXT NOT NULL CHECK (precedence IN ('preferred', 'lower_priority_copy', 'may_coexist', 'unknown')),
    evidence_reference TEXT,
    researched_at TEXT,
    applicable_platforms_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (agent_client_id, directory_node_id)
);

CREATE TABLE source_relations (
    provenance_id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    directory_node_id TEXT REFERENCES directory_nodes(node_id) ON DELETE SET NULL,
    agent_client_id TEXT,
    source_path TEXT NOT NULL,
    source_path_key TEXT NOT NULL,
    relationship TEXT NOT NULL CHECK (relationship IN ('import_copy', 'shared_directory_read', 'shared_directory_reference', 'managed_copy', 'managed_link', 'observed_copy', 'observed_link', 'unknown')),
    file_representation TEXT NOT NULL CHECK (file_representation IN ('directory', 'symbolic_link', 'directory_junction', 'copy', 'unknown')),
    ownership TEXT NOT NULL CHECK (ownership IN ('skillhub_managed', 'observed_unmanaged', 'shared_reference')),
    link_target_path TEXT,
    link_target_directory_id TEXT REFERENCES directory_nodes(node_id) ON DELETE SET NULL,
    content_fingerprint TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('local', 'https', 'git')),
    source_locator TEXT NOT NULL,
    imported_at INTEGER NOT NULL
);

CREATE INDEX idx_source_relations_skill ON source_relations(skill_id, imported_at, provenance_id);
CREATE INDEX idx_source_relations_path ON source_relations(source_path_key);

CREATE TABLE deployment_relations (
    relation_id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
    agent_client_id TEXT NOT NULL,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    directory_node_id TEXT REFERENCES directory_nodes(node_id) ON DELETE SET NULL,
    relationship TEXT NOT NULL CHECK (relationship IN ('import_copy', 'shared_directory_read', 'shared_directory_reference', 'managed_copy', 'managed_link', 'observed_copy', 'observed_link', 'unknown')),
    file_representation TEXT NOT NULL CHECK (file_representation IN ('directory', 'symbolic_link', 'directory_junction', 'copy', 'unknown')),
    ownership TEXT NOT NULL CHECK (ownership IN ('skillhub_managed', 'observed_unmanaged', 'shared_reference')),
    link_target_path TEXT,
    link_target_path_key TEXT,
    link_target_directory_id TEXT REFERENCES directory_nodes(node_id) ON DELETE SET NULL,
    content_fingerprint TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('scan', 'import')),
    match_state TEXT NOT NULL CHECK (match_state IN ('content_verified', 'name_only', 'diverged')),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    observed_at INTEGER NOT NULL,
    released_at INTEGER,
    UNIQUE (agent_client_id, path_key)
);

CREATE INDEX idx_deployment_relations_skill ON deployment_relations(skill_id, active);
CREATE INDEX idx_deployment_relations_directory ON deployment_relations(directory_node_id, active);

CREATE TABLE conflict_cases (
    conflict_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('unknown', 'duplicate_same_content', 'same_name_different_content', 'same_source_fork', 'shared_directory_duplicate', 'unknown_directory_recognition')),
    classification TEXT NOT NULL CHECK (classification IN ('same_skill_version', 'distinct_skill', 'uncertain')),
    member_skill_ids_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL,
    user_decision TEXT CHECK (user_decision IS NULL OR user_decision IN ('same_skill_version', 'distinct_skill', 'uncertain')),
    decided_at INTEGER
);

CREATE TABLE conflict_case_members (
    member_id TEXT PRIMARY KEY NOT NULL,
    conflict_id TEXT NOT NULL REFERENCES conflict_cases(conflict_id) ON DELETE CASCADE,
    skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
    version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
    provenance_id TEXT REFERENCES source_relations(provenance_id) ON DELETE SET NULL,
    directory_node_id TEXT REFERENCES directory_nodes(node_id) ON DELETE SET NULL,
    path TEXT,
    fingerprint TEXT
);

CREATE TABLE governance_tasks (
    task_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('select_authoritative_version', 'classify_same_name_skill', 'confirm_shared_directory_impact', 'convert_copy_to_managed_link', 'convert_shared_reference_to_managed_link', 'unknown_directory_recognition', 'operation_failure_recovery')),
    subject_id TEXT NOT NULL,
    detail TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE INDEX idx_governance_tasks_pending ON governance_tasks(resolved, created_at, task_id);

-- Every 0013 import row becomes a compatibility source fact.  The generated
-- id is deliberately not the old skill_id and is never reused for new events.
INSERT INTO source_relations (
    provenance_id, skill_id, directory_node_id, agent_client_id, source_path,
    source_path_key, relationship, file_representation, ownership,
    link_target_path, link_target_directory_id, content_fingerprint, source_kind,
    source_locator, imported_at
)
SELECT
    'legacy-provenance:' || skill_id,
    skill_id,
    NULL,
    agent_client_id,
    original_path,
    original_path,
    'import_copy',
    'directory',
    CASE ownership
        WHEN 'central_library' THEN 'skillhub_managed'
        ELSE 'observed_unmanaged'
    END,
    NULL,
    NULL,
    content_fingerprint,
    source_kind,
    source_locator,
    imported_at
FROM import_provenance;

-- Unreliable observations must not manufacture a Skill identity.
INSERT INTO deployment_relations (
    relation_id, skill_id, agent_client_id, path, path_key, directory_node_id,
    relationship, file_representation, ownership, link_target_path,
    link_target_path_key, link_target_directory_id, content_fingerprint, origin,
    match_state, active, observed_at, released_at
)
SELECT
    'legacy-observed:' || id,
    CASE WHEN match_state = 'content_verified' THEN skill_id ELSE NULL END,
    client_id,
    original_path,
    path_key,
    NULL,
    'unknown',
    'unknown',
    'observed_unmanaged',
    NULL,
    NULL,
    NULL,
    content_fingerprint,
    origin,
    match_state,
    CASE WHEN status = 'active' THEN 1 ELSE 0 END,
    observed_at,
    released_at
FROM observed_deployments;

-- Existing SkillHub-created deployments remain readable through deployments;
-- also project their stable relation facts for unified relationship queries.
INSERT INTO deployment_relations (
    relation_id, skill_id, agent_client_id, path, path_key, directory_node_id,
    relationship, file_representation, ownership, link_target_path,
    link_target_path_key, link_target_directory_id, content_fingerprint, origin,
    match_state, active, observed_at, released_at
)
SELECT
    'legacy-managed:' || d.id,
    d.skill_id,
    t.agent_id,
    CASE WHEN d.runtime_name = '' THEN t.path
         ELSE rtrim(t.path, '/\\') || '/' || d.runtime_name END,
    CASE WHEN d.runtime_name = '' THEN t.path
         ELSE rtrim(t.path, '/\\') || '/' || d.runtime_name END,
    NULL,
    CASE d.method
        WHEN 'symbolic_link' THEN 'managed_link'
        WHEN 'directory_junction' THEN 'managed_link'
        ELSE 'managed_copy'
    END,
    CASE d.method
        WHEN 'symbolic_link' THEN 'symbolic_link'
        WHEN 'directory_junction' THEN 'directory_junction'
        ELSE 'copy'
    END,
    CASE WHEN d.managed = 1 THEN 'skillhub_managed' ELSE 'observed_unmanaged' END,
    NULL,
    NULL,
    NULL,
    d.expected_hash,
    'import',
    'content_verified',
    CASE WHEN d.state IN ('deployed', 'active') THEN 1 ELSE 0 END,
    d.updated_at,
    CASE WHEN d.state IN ('deployed', 'active') THEN NULL ELSE d.updated_at END
FROM deployments d
JOIN targets t ON t.id = d.target_id
ON CONFLICT(agent_client_id, path_key) DO UPDATE SET
    relation_id=excluded.relation_id,
    skill_id=excluded.skill_id,
    path=excluded.path,
    relationship=excluded.relationship,
    file_representation=excluded.file_representation,
    ownership=excluded.ownership,
    content_fingerprint=excluded.content_fingerprint,
    origin=excluded.origin,
    match_state=excluded.match_state,
    active=excluded.active,
    observed_at=excluded.observed_at,
    released_at=excluded.released_at;
