# Plan 05 Task 5：外部部署变化检测与收集

## 状态

已完成并进入 `main`，代码提交为 `f23b25c`。

## 本次完成

- 增加 `ExternalChangeState`、`ExternalChangeObservation`、`ReconcilePlan` 和 `ReconcileResult`，用结构化结果区分未变化、已修改、目标缺失和已忽略。
- 增加平台后端边界 `ReconcileBackend`。后端负责比较文件系统身份、目标树哈希和当前版本清单；核心层不推断 Agent 是否加载或可用。
- 增加 `ReconcileService`，要求先重新检查当前目标，再执行用户明确选择的操作：收集为新版本、恢复所选版本、保留独立副本、忽略本次外部变化。
- 缺失目标不会被静默重建；收集只允许对已修改目标执行；保留独立副本不修改目标文件，只解除管理关系；忽略只保存范围明确的证据，不改变文件内容。
- 冻结 API 命令 `CollectDeploymentChanges`、`RestoreDeployment`、`KeepIndependentCopy`、`IgnoreExternalChange` 和查询 `GetReconcilePlan`，同步生成 TypeScript bindings。

## 验证

- `cargo test -p skillhub-core --test external_changes`
- `cargo test -p skillhub-core --test api_contract`
- `cargo test --locked --workspace`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。Windows 链接器输出的既有提示不构成失败。

## 后续边界

本 Task 提供核心模型、服务和 API 合约，不在本 Task 中接入具体 SQLite 关系持久化、文件系统适配器或 ApplicationFacade；这些由后续 Task 的执行/恢复与桌面联调工作接入。
