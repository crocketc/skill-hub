-- Optional AI conflict analysis records (design §3.4).  Records are advisory
-- traces only: they never replace a conflict case's user decision, which stays
-- in conflict_cases.user_decision.

CREATE TABLE conflict_analysis_records (
    record_id TEXT PRIMARY KEY NOT NULL,
    conflict_id TEXT NOT NULL REFERENCES conflict_cases(conflict_id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('all', 'category', 'case', 'skill')),
    scope_subject TEXT,
    input_fingerprint TEXT NOT NULL,
    baseline_classification TEXT NOT NULL CHECK (baseline_classification IN ('same_skill_version', 'distinct_skill', 'uncertain')),
    conclusion_json TEXT,
    source TEXT NOT NULL CHECK (source IN ('deterministic_only', 'llm')),
    analyzed_at INTEGER NOT NULL,
    failure_code TEXT,
    adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1))
);

CREATE INDEX idx_conflict_analysis_records_case
    ON conflict_analysis_records(conflict_id, analyzed_at, record_id);
