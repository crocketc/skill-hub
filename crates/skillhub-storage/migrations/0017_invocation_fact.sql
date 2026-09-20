-- DEV-28: persist the read-only invocation policy fact (source + producing field)
-- alongside the parsed runtime requirements. Existing rows default to the safe
-- "default" source; the import/capture path overwrites with the resolved fact.
ALTER TABLE catalog_skill_metadata ADD COLUMN invocation_source TEXT NOT NULL DEFAULT 'default';
ALTER TABLE catalog_skill_metadata ADD COLUMN invocation_field TEXT;
