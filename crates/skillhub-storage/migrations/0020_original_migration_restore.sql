-- 计划 8.7：回滚会新建活动来源关系；迁移记录显式关联新旧关系。
ALTER TABLE original_migrations ADD COLUMN restored_relation_id TEXT REFERENCES source_copy_relations(relation_id);
