-- AR-021：用户可维护的版本名。来源版本号/用户版本/内容哈希三者分离的
-- 存储基础：label 由用户显式命名，version_id（内容哈希）保持不变。
CREATE TABLE IF NOT EXISTS version_labels (
    version_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
