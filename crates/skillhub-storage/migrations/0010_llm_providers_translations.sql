-- 0010: LLM provider configurations and persisted description translations.
-- Provider configs hold credential references only; secret material lives in
-- the OS credential store and never enters this database.
CREATE TABLE IF NOT EXISTS llm_provider_configs (
    id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- View-layer description translations. One latest record per (skill, language);
-- source_description_hash drives the "needs update" state, origin distinguishes
-- generated translations from user revisions.
CREATE TABLE IF NOT EXISTS translation_records (
    skill_id TEXT NOT NULL,
    language TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    source_description_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    origin TEXT NOT NULL,
    version_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (skill_id, language)
);
