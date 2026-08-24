ALTER TABLE check_runs
    ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE check_findings
    ADD COLUMN allowed_dispositions_json TEXT;
