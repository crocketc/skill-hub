# Plan 05 Task 7：健康检查、修复计划与崩溃恢复

## 状态

已完成并进入 `main`，代码提交为 `08c92e9`。

## 本次完成

- 增加确定性的 `HealthFinding`、`HealthReport` 和 `RepairPlan`，以结构化代码报告清单、对象完整性、临时文件和未完成操作等可验证异常。
- 增加 `HealthService` 的检查、准备修复和提交修复流程，修复按单条发现项执行，不猜测文件内容；修复失败时保留准备状态以便重试。
- 增加 `RecoveryCandidate` 和 `RecoveryService`，启动后列出未完成操作允许的完成/回滚动作，只接受候选项声明过的动作。
- 冻结 `RunHealthCheck`、`PrepareRepair`、`CommitRepair`、`ResolveRecovery` 命令和 `ListRecoveryCandidates` 查询，新增健康/修复/恢复类型并生成 TypeScript bindings。
- 为 `RecoveryAction` 补充 Specta 类型导出，保持 Rust 合约与前端 bindings 一致。

## 验证

- `cargo test -p skillhub-core --test health_repair --test recovery`
- `cargo test -p skillhub-core --test api_contract`
- `cargo test --locked --workspace`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。

## 后续边界

本 Task 提供核心层的确定性检查、逐项修复和恢复决策边界；实际数据库扫描器、文件系统修复适配器、操作日志接线和 ApplicationFacade 联调仍需后续任务接入。
