-- Nullable health details preserve the distinction between legacy/unverified
-- rows and rows whose latest check found no target health anomaly.
ALTER TABLE deployment_relations ADD COLUMN health_reasons_json TEXT;
