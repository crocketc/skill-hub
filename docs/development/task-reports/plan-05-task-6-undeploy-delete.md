# Plan 05 Task 6：解除部署与删除选择

## 状态

已完成并进入 `main`，代码提交为 `8d638d6`。

## 本次完成

- 增加 `RemovalImpact`，在删除或解除部署前返回中心 Skill、Agent/项目部署关系、共享物理目标提示和待处理依赖。
- 增加 `RemovalService` 的准备/提交边界，删除包含部署关系时必须为每条关系提供明确决定，不能空决定或默认级联。
- 支持移除受管目标、保留共享部署并解除关系、仅解除关系、解除管理但保留文件、取消等明确操作。
- 解除部署只作用于选定关系；移除一条共享物理目标关系不会删除共享文件，中心库 Skill 也不会因解除部署被删除。
- 冻结 `PrepareUndeploy`、`CommitUndeploy`、`PrepareDeleteSkill`、`CommitDeleteSkill`、`DetachManagement` 命令和 `GetRemovalImpact` 查询，并同步生成 TypeScript bindings。

## 验证

- `cargo test -p skillhub-core --test undeploy_delete`
- `cargo test -p skillhub-core --test api_contract`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。

## 后续边界

本 Task 提供核心层的影响分析、显式决策和适配器边界；具体 SQLite 持久化、文件系统所有权校验和 ApplicationFacade 接线在后续执行/恢复与桌面联调任务中完成。
