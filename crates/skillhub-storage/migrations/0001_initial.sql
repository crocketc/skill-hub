CREATE TABLE skills (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    runtime_name TEXT NOT NULL,
    original_description TEXT NOT NULL DEFAULT '',
    translated_description TEXT,
    user_note TEXT NOT NULL DEFAULT '',
    author TEXT,
    license TEXT,
    call_policy TEXT NOT NULL DEFAULT 'automatic_and_manual',
    lifecycle TEXT NOT NULL DEFAULT 'normal',
    ownership TEXT NOT NULL DEFAULT 'user_created',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE versions (
    id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source_version TEXT,
    UNIQUE(skill_id, content_hash)
);

CREATE TABLE current_pointers (
    skill_id TEXT PRIMARY KEY NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE RESTRICT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE sources (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    locator TEXT NOT NULL,
    revision TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE TABLE skill_sources (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'origin',
    PRIMARY KEY(skill_id, source_id)
);

CREATE TABLE tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE skill_tags (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(skill_id, tag_id)
);

CREATE TABLE combinations (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE combination_skills (
    combination_id TEXT NOT NULL REFERENCES combinations(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY(combination_id, skill_id),
    UNIQUE(combination_id, position)
);

CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE targets (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    path TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    UNIQUE(agent_id, project_id, scope, path)
);

CREATE TABLE deployments (
    id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE RESTRICT,
    target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    method TEXT NOT NULL,
    managed INTEGER NOT NULL DEFAULT 1 CHECK(managed IN (0, 1)),
    runtime_name TEXT NOT NULL,
    expected_hash TEXT NOT NULL,
    observed_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(target_id, runtime_name)
);

CREATE TABLE check_runs (
    id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    ruleset_id TEXT,
    model_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    coverage_json TEXT NOT NULL DEFAULT '{}',
    failure_code TEXT
);

CREATE TABLE check_findings (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    file_path TEXT,
    line_start INTEGER,
    line_end INTEGER,
    evidence_hash TEXT,
    message_params_json TEXT NOT NULL DEFAULT '{}',
    disposition TEXT NOT NULL DEFAULT 'actionable'
);

CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    phase TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    progress_json TEXT NOT NULL DEFAULT '{}',
    inverse_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE pending_dismissals (
    id TEXT PRIMARY KEY NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    evidence_hash TEXT,
    reason_code TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    UNIQUE(scope_type, scope_id, evidence_hash, reason_code)
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
