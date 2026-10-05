-- W3-1（FB-003 裁决第 1 节）：安全预警状态表。
-- 危险级"仍要导入"与全部警告级导入后，该 Skill 进入预警状态：不可派发、
-- 加入待办，直到用户完全信任（留痕）或删除。预警与信任记录都绑定内容
-- 版本（version_id = 版本内容哈希身份）：同版本不重复提示；版本内容变化
-- 产生新行即重新预警。
-- 唯一性设计：主键 (skill_id, version_id, decision_source)——同一版本上
-- "import"（导入产生的预警）与 "trust"（待办"完全信任"的留痕）各至多一行；
-- 信任留痕存在时导入不再复活同版本预警。
CREATE TABLE security_alerts (
    skill_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    level TEXT NOT NULL,
    state TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    decision_source TEXT NOT NULL,
    PRIMARY KEY (skill_id, version_id, decision_source)
);

CREATE INDEX idx_security_alerts_skill ON security_alerts(skill_id, state);
