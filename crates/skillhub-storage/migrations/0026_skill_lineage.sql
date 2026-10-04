-- K5/MS-04：复用修改血缘。「来源 skill+version → 新 skill 首版本」的
-- 有向事实，每主体至多一条（仅首版本的来源）。原主体、旧版本与网络来源
-- 不受影响；查询侧经 catalog 详情投影暴露上游谱系。
CREATE TABLE skill_lineage (
    skill_id TEXT PRIMARY KEY NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL,
    origin_skill_id TEXT NOT NULL,
    origin_version_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_skill_lineage_origin ON skill_lineage(origin_skill_id);
