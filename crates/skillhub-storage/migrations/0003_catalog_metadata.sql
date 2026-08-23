CREATE TABLE catalog_skill_metadata (
    skill_id TEXT PRIMARY KEY NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    requirements_json TEXT NOT NULL DEFAULT '[]',
    trial_due TEXT
);
