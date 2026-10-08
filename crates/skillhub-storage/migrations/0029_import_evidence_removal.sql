-- #12（2026-10-07 治理裁决）：主体名下全部使用关系随删除一并删除——
-- 「技能都删了，关系肯定就都删了……相当于恢复到没导入状态」。
-- 0019 的 import_events_no_delete 触发器把存证事件删除整体禁止，导致
-- remove_sync 无法清空主体名下的导入关系记录，75/75 个技能删除被
-- 外键链拦截。行的内容不可改写边界保持不变（import_events_no_update
-- 保留）；存证删除此后由主体删除编排按 skill_id 显式执行。
DROP TRIGGER IF EXISTS import_events_no_delete;
