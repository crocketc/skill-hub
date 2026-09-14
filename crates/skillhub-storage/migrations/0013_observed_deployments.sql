-- OPT-20260914-08：已部署 Skill 识别、导入集中库与部署关系。
--
-- 1) import_provenance：导入即存证。一次导入提交时的不可变事实
--    （来源快照/Agent 形态/原始路径/导入时间/内容指纹/所有权状态）。
--    与 sources/skill_sources 的差别：这里记录"导入那一刻"，后续
--    relink 不改写历史。agent_client_id 允许为 NULL——来源不明必须
--    显式缺省，不允许猜测归属。
-- 2) observed_deployments：已观察部署关系（Agent 形态 client_id、原始
--    路径、Skill 标识、内容指纹）。这是观察事实，不是 SkillHub 创建
--    的部署：SkillHub 对它只有记录与标注，收回部署永不删除该路径。
--    path_key 唯一（Windows 形态折叠、POSIX 精确，由 Rust 侧写入时
--    计算，避免依赖 SQLite 大小写排序），同一路径重复导入/扫描不重复
--    建档。
-- 3) original_migrations：原始文件清理（迁移）的审计与回滚记录。只在
--    用户明确确认所有权后产生 Migrated 行；回滚后标记 RolledBack，
--    备份路径始终保留供追溯。

CREATE TABLE import_provenance (
    skill_id TEXT PRIMARY KEY NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    agent_client_id TEXT,
    original_path TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_locator TEXT NOT NULL,
    ownership TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    imported_at INTEGER NOT NULL
);

CREATE TABLE observed_deployments (
    id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    original_path TEXT NOT NULL,
    path_key TEXT NOT NULL UNIQUE,
    content_fingerprint TEXT NOT NULL,
    match_state TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    released_at INTEGER
);

CREATE INDEX idx_observed_deployments_skill ON observed_deployments(skill_id);

CREATE TABLE original_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    original_path TEXT NOT NULL,
    backup_path TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    confirmed_at INTEGER NOT NULL,
    rolled_back_at INTEGER
);
