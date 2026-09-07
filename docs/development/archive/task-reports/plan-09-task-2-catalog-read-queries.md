# Plan 09 Task 2：技能目录只读查询接入

状态：已完成（目录身份与搜索）

## 目标

复用已经冻结的 `ApplicationFacade` 查询契约，先让本地门面能够读取 Skill 基本身份并执行 FTS5/BM25 搜索，为后续桌面技能库真实数据接入提供稳定基础。

## 已完成

- `GetSkill` 查询从 SQLite 目录返回 Skill ID、显示名称和运行时名称。
- Skill 不存在时返回 `object.not_found` 结构化错误。
- `Search` 查询复用 `skillhub-storage` 的 FTS5/BM25 实现，返回排序后的搜索命中和高亮字段。
- 为同步 SQLite 查询增加目录身份读取方法，避免在 `Send` 的应用门面中跨越非 `Send` 的目录异步边界。
- 未支持的其他查询和所有写命令继续返回结构化错误，不执行隐式写入。

## 测试与验证

- `cargo test -p skillhub-application --test facade`：4 项通过。
- `cargo test --workspace --locked`：在本任务前置闭环基础上已通过；本次改动后应再次运行阶段 CI。
- `cargo fmt --all -- --check`：通过。
- `git diff --check`：通过。

## 明确未包含

- 这不是完整的技能库分页/筛选查询；前端所需的表格行、部署关系、检查状态和 facets 仍需后续冻结应用查询映射。
- 当前仍未接通导入、部署、检查等写操作，也未替换前端生产页面中的 Mock/Unavailable Facade。
