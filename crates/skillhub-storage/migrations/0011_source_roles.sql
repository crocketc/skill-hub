-- P1-05 来源角色：
-- 1) sources 增加角色列。旧行全部默认 local_only（向后兼容的诚实缺省——
--    升级前的行没有经过本语义的显式确认）。
-- 2) 唯一例外：kind=git 且 metadata_json 带 branch+directory 非空坐标的旧行，
--    是旧导入管线在用户提交导入时写下的可验证上游坐标，回填为
--    verified_upstream，保证升级后 upstream_for_skill 继续可读（迁移回归测试
--    v10_database_upgrades_source_roles_and_keeps_legacy_upstreams_readable 钉住）。
-- 3) 新增 search_candidates 候选表：联网搜索候选的一等持久化实体。
--    候选绝不写入 sources/skill_sources；provider_source_id 唯一，重复保存
--    不会产生重复行；status 三态 pending/confirmed/dismissed。

ALTER TABLE sources ADD COLUMN role TEXT NOT NULL DEFAULT 'local_only';

UPDATE sources SET role='verified_upstream'
WHERE kind='git'
  AND json_extract(metadata_json, '$.branch') IS NOT NULL
  AND json_extract(metadata_json, '$.branch') != ''
  AND json_extract(metadata_json, '$.directory') IS NOT NULL
  AND json_extract(metadata_json, '$.directory') != '';

CREATE TABLE search_candidates (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    provider_source_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    locator TEXT NOT NULL,
    page_url TEXT NOT NULL,
    installs INTEGER NOT NULL DEFAULT 0,
    via TEXT NOT NULL DEFAULT 'original_query',
    status TEXT NOT NULL DEFAULT 'pending',
    first_seen_at INTEGER NOT NULL
);

CREATE INDEX idx_search_candidates_status ON search_candidates(status);
