# Plan 05 Task 9：精确、可逆的忽略规则

## 完成内容

- 增加 `IgnoreSubject`，只允许三类精确身份：路径、Skill ID、待处理项 ID。
- 路径规则拒绝通配符、正则表达式、脚本式条件、换行和目录穿越片段。
- 增加 `IgnoreRule`，保存规则 ID、原因、创建时间占位和可选的延期时间。
- 增加 `IgnoreService` 与 `IgnoreBackend` 边界，支持创建、列表、精确匹配和移除；移除后可恢复待处理项可见性。
- 增加 `CreateIgnoreRule`、`RemoveIgnoreRule` 命令和 `ListIgnoreRules` 查询，并生成 TypeScript bindings。
- 忽略规则只影响匹配的扫描/待处理投影，不删除文件、不修改 Skill 内容、不替代安全检查，也不会扩大到相邻路径或相似 Skill。

## 测试与验证

- `cargo test -p skillhub-core --test ignore_rules --test api_contract`
- `cargo test --locked --workspace`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。Windows 链接器输出的既有提示不影响测试结果。

## 边界与后续接入

本 Task 冻结了核心模型、服务和 API 合约；实际 SQLite 持久化、扫描器/待处理投影接入、ApplicationFacade 和 UI 操作仍由后续联调任务完成。规则创建时间由持久化适配器负责写入实际时间，核心层不自行读取系统时钟。
