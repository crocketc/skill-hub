# Plan 04 Task 5：确定性重复与同名冲突分析

完成日期：2026-08-29

## 完成内容

- 增加导入冲突领域模型：`DuplicateKind`、`MatchBasis`、`ImportMatch`、`ImportConflict`、`ImportAnalysis`。
- 以固定顺序比较候选 Skill 与已有 Skill：规范化运行时名称、来源定位、规范化树哈希和 FTS/BM25 候选证据。
- 精确内容提供复用、建立受管关联、复制到集中库或跳过等明确决策。
- 同名不同内容进入需要用户选择的冲突；决策集合不包含覆盖已有目标。
- 对 Agent 内置或插件只读 Skill，精确重复只允许作为独立受管 Skill 复制。
- 增加 SQLite 只读导入投影，读取现有 Skill、当前版本内容哈希、来源和所有权。
- 新增 `AnalyzeImport` 查询契约，并重新生成 TypeScript bindings。

## 测试与验证

- `cargo test -p skillhub-core --test import_conflicts`
- `cargo test -p skillhub-storage --test import_repository`
- `cargo test --workspace`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。

## 范围边界

本 Task 只负责分析和读取事实，不执行复制、接管、来源获取、部署或覆盖。统一导入提交进入 Plan 04 Task 6。
