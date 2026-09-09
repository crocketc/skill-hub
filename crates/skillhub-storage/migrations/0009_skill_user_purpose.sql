-- QA-008：用途说明是独立于原文和译文的用户元数据字段。
ALTER TABLE skills ADD COLUMN user_purpose TEXT NOT NULL DEFAULT '';
