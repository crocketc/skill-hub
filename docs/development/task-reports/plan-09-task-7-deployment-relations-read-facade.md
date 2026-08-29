# Plan 09 Task 7：部署关系只读查询接入

## 目标

将 SQLite 中已经记录的部署事实接入共享 `ApplicationFacade`，为技能详情和后续关系视图提供同一份只读数据，不在查询阶段推断 Agent 是否可用或是否真正加载了 Skill。

## 已完成

- `ListDeployments` 已接入本地门面，支持无筛选列出全部部署记录，也支持按 `skill_id` 精确筛选。
- `GetDeploymentRelations` 已接入本地门面，按 Skill 返回当前仍具关系意义的 `Deployed` 和 `NeedsRecovery` 记录。
- `Planned` 与 `Removed` 记录保留在部署历史查询中，但不会出现在当前关系投影中。
- 查询复用 SQLite 部署仓库的确定性 `created_at, id` 排序，并返回原始部署事实：版本、物理目标、部署方式、管理标记、期望/观察哈希和状态。
- 关系查询不根据 `target_id` 猜测 Agent/项目标签、授权状态、运行时可用性或调用能力。
- 前端版本时间线和关系面板仍保留 unavailable 边界，待关系标签、项目/Agent 目录投影和完整原生契约冻结后再接入，避免用物理目标 ID 伪造展示语义。

## 验证

- `cargo test -p skillhub-application --test facade`：7/7 通过。
- 新增测试覆盖：按 Skill 过滤、排除其他 Skill、排除计划中和已移除记录。
- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`：通过。

## 后续

需要在 macOS 上复核最新提交；后续 Task 再接入 Agent/项目目录投影、关系标签、检查状态和部署写操作，保持当前查询只反映已持久化事实。
