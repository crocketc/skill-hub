# Plan 05 Task 4：单目标与批量部署编排

## 状态

已完成并提交到 `main`：`3323f79 feat: orchestrate single and batch deployments`。

## 完成内容

- 增加 `DeploymentService`，将已生成的部署计划拆为准备和提交两个阶段。
- 提交前通过后端重新校验计划，避免使用过期目标事实；同一物理目标在计划中只应用一次。
- 单目标和批量目标均返回逐目标结构化结果，包含状态、物理/逻辑目标、版本、部署 ID 和失败错误码。
- 单个目标失败不会中断其他目标；部分失败时保留未完成的准备会话，允许后续恢复处理。
- 增加 `PrepareDeployment`、`CommitDeployment` 命令，以及 `ListDeployments`、`GetDeploymentRelations` 查询契约和 TypeScript bindings。

## 验证

- `cargo test --locked --workspace`：通过。
- `cargo test -p skillhub-core --test deploy_flow`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。
- `git diff --check`：通过。

## 未包含范围

- 具体文件系统部署执行器已在前置 Task 完成，但真实 ApplicationFacade、操作日志持久化、外部变化收集和删除闭环仍在后续 Task。
