# Task 5 实现报告

## 修改文件

- `apps/desktop/src/features/import/api.ts`
- `apps/desktop/src/features/import/ImportWizard.tsx`
- `apps/desktop/src/features/import/ImportSummary.tsx`
- `apps/desktop/src/features/import/ImportSummary.test.tsx`
- `apps/desktop/src/features/relationshipGovernance/relationshipGovernance.ts`
- `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.tsx`
- `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`

## TDD 红绿过程

1. 先新增导入摘要用例，要求部分导入后明确原始副本保留并显示治理待办入口；首次 Vitest 失败，缺少保留说明。
2. 以最小实现扩展 `ImportResult` 并在摘要展示说明与入口；同一用例转绿。
3. 先新增治理面板用例，要求分组影响说明、展开成员、单项覆盖优先、AI 未配置不取代确定性判断、待办入口；首次执行因面板模块不存在而失败。
4. 新增纯前端治理模型与面板；用例转绿。随后把该面板作为有后端分组时才出现的导入阶段接入，避免改变既有来源门槛、候选选择、冲突分析进度和后台任务。

## 命令与结果

- `pnpm --dir apps/desktop exec vitest run src/features/import/ImportSummary.test.tsx`：红（新增保留/待办断言失败），随后绿（5/5）。
- `pnpm --dir apps/desktop exec vitest run src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`：红（模块不存在），随后绿（与摘要合计 7/7）。
- `pnpm --dir apps/desktop exec vitest run src/features/import/ImportWizard.test.tsx src/features/import/ConflictResolution.test.tsx src/features/import/ImportSummary.test.tsx src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`：73/73 通过。
- `pnpm --dir apps/desktop exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 自审

- 前端只渲染 `governanceGroups`，不从路径、候选名或 AI 输出重新推断关系。
- 分组默认动作与单项覆盖分离，读取时单项覆盖优先。
- 面板明确集中库导入与原始副本处理独立，摘要只声明保留，不会触发删除。
- 治理阶段只在 native plan 提供分组时插入，既有导入步骤、来源门槛、冲突分析进度和后台提交语义保持兼容。

## 完整闭环补充

- 简报列出的 `crates/skillhub-application/src/import_service.rs` 在本 worktree 不存在；实际导入 facade 位于 `crates/skillhub-application/src/lib.rs`，已在该入口实现 prepare/commit 校验和任务写入。核心可复用服务仍位于 `crates/skillhub-core/src/application/import_service.rs`。
- `prepare_import` 返回按真实候选所有权和确定性冲突导出的 `ImportGovernanceGroup`；`commit_import` 要求显式组确认或全成员确认，拒绝未知 group/member/action，成员覆盖优先。
- `CreateTodo` 写入既有 `GovernanceTaskRepository`，返回 `GovernanceTaskFact`（稳定 task_id、kind、subject、detail），并可通过 `GetRelationshipOverview` 查询；未使用 PendingItems 或 URL 锚点。
- 导入结果逐项返回 `succeeded`/`skipped` 状态、结构化 reason_code、原件保留状态和治理任务。导入不删除原始来源；原始迁移仍是独立流程。
- 前端只消费生成 bindings 的治理 DTO；批量分析合并同类原生 group，提交时按 prepared import 过滤决定。治理面板的 AI 未配置提示只作 advisory（建议），不会替代确定性确认。

## 本轮验证

- `SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings`：通过。
- `cargo test -p skillhub-application --test facade_relationship_governance`：32/32 通过（新增显式确认与治理待办回查）。
- `cargo test -p skillhub-application --test facade_observed_deployments`：7/7 通过。
- `cargo test -p skillhub-core --test import_conflicts`：4/4 通过。
- `pnpm --dir apps/desktop exec vitest run src/features/import/ImportWizard.test.tsx src/features/import/ConflictResolution.test.tsx src/features/import/ImportSummary.test.tsx src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx src/features/import/nativeApi.test.ts`：84/84 通过。

## 剩余真实风险

- AI 可用性目前由导入 facade 是否提供预检能力传入；真实 provider 配置仍由已有 AI 预检调用在执行时验证，且不影响确定性导入/治理选择。
