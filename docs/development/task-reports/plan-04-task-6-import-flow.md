# Plan 04 Task 6：统一安全导入流程

## 状态

已完成并提交到 `main`：`1ec3746 feat: add unified safe Skill import operation`。

## 完成内容

- 增加 `ImportService`，将导入拆为准备、提交和取消三个明确阶段。
- 准备阶段保存候选 Skill 与确定性冲突分析快照，不修改集中库或来源文件。
- 提交阶段只接受准备快照中允许的 `ImportDecision`，拒绝绕过冲突选择的任意决策。
- 本地复制、复用已有 Skill、建立受管关系、独立复制、跳过和接管后的结果均结构化返回。
- 接管操作按“复制到集中库 → 验证受管副本 → 移除原文件”的顺序执行；验证或后续副作用失败时保留原文件和准备会话。
- 增加 `PrepareImport`、`CommitImport`、`CancelImport` 命令及 `PreparedImport`、`ImportItemResult`、`ImportSummary` 结果契约，并重新生成 TypeScript bindings。
- 同名不同内容、同来源和无匹配候选仅在已识别 Agent/项目目录中提供接管选项；内置或插件 Skill 不提供接管选项。

## 验证

- `cargo test --locked --workspace`：通过。
- `cargo test -p skillhub-core --tests`：通过，包含导入流程、冲突分析和 API 契约测试。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。
- `git diff --check`：通过。

## 未包含范围

- 尚未接入具体的 Tauri ApplicationFacade、文件选择器和真实文件系统导入后端。
- 来源重连、上游更新和 skills.sh 在线发现分别属于 Plan 04 Task 7–8。
