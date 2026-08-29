CREATE TABLE IF NOT EXISTS llm_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    profile_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
