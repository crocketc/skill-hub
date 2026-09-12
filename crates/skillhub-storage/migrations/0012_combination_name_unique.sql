-- 0012：combinations.name 唯一约束（终审挂账的防御性数据加固）。
--
-- 语义对齐：facade 的重名判定一直是二进制精确匹配（WHERE name=?1，
-- TargetExists / 同名歧义），因此唯一索引同样使用默认 BINARY 排序，
-- 不引入 NOCASE 之类的行为变更。
--
-- 正常写入路径不可能出现重名；以下去重仅防御历史异常或外部篡改：
-- 1) 同名保留最老（created_at,id）一行，其余按年龄序追加 '-2'、'-3'…；
-- 2) 追加后若仍与既有名冲突（例如库中已存在 'pdf-2'），冲突组整体改为
--    'name (id)'，用 UUID 兜底保证唯一（该路径仅存在于损坏库，可再改名）。
-- 最后建唯一索引；若至此仍有重复，迁移将响亮失败——前置已有
-- recovery_point 备份，不得静默吞掉数据异常。

UPDATE combinations
SET name = combinations.name || '-' || r.rn
FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at, id) AS rn
    FROM combinations
) AS r
WHERE combinations.id = r.id AND r.rn > 1;

UPDATE combinations
SET name = combinations.name || ' (' || combinations.id || ')'
FROM (
    SELECT name AS dup_name FROM combinations GROUP BY name HAVING COUNT(*) > 1
) AS d
WHERE combinations.name = d.dup_name;

CREATE UNIQUE INDEX combinations_name_unique ON combinations(name);
