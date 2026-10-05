-- W1-3（FB-006 裁决 A）：导入边界扫描结果登记为该内容版本的首次基础检查
-- 记录，需要区分触发来源。`manual` 兼容全部既有行与既有写入路径；
-- `import` 标注由导入流程登记的检查。新列只加默认值，不改既有语义。
ALTER TABLE check_runs
    ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual';
