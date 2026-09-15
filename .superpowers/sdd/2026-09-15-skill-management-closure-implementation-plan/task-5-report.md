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

## 复审修复轮次（2026-09-15）

### 修复内容

- `TakeOverAfterVerify` 已在生产 application facade（应用门面）中实现为复制、核验内容指纹、保留原始来源；没有把删除原件混入导入提交。原件删除仍只由独立的 original migration（原件迁移）流程执行，该流程已有显式确认、备份和回退事实。新增 facade 集成测试锁定“接管成功且原件仍存在”。
- 导入结果新增稳定 `todo` 状态。native facade（原生门面）逐候选捕获失败时保留 `reasonCode`、`originalPreserved: true` 和空治理任务列表；成功、跳过、失败和待处理结果均不再由 catch 丢失结构化字段。未知错误继续返回失败，不静默成功。
- ImportSummary 不再直接渲染机器 `reasonCode`，已通过 `keyedMessage`（键化消息）映射到 i18n（国际化）文案，未知码使用通用可读文案；摘要新增待处理计数和状态。
- DiscoveryRoute（生产发现路由）向 ImportWizard 传入真实治理待办处理器；点击摘要入口会导航回本地发现入口并触发既有 `get_relationship_overview` 查询。新增生产路由链路测试。
- 新增真正的 ImportWizard 集成测试：mock plan 返回 `governance_groups`，覆盖治理阶段、确认后 commit 收到治理 decision（决策）、分组动作和成员 override（覆盖）优先；RelationshipGovernancePanel 新增分组动作及默认成员动作测试。AI 仍仅为 advisory-only（建议性）。
- core application ImportService（核心应用服务）保留为通用、可注入 backend（后端）测试服务；它不持有治理 decision，也不负责持久化治理任务。生产契约由 `crates/skillhub-application/src/lib.rs` facade 负责，现已与生成 bindings（绑定）和前端四态结果契约对齐，避免无关重构。

### 本轮 TDD 与验证

- 先加入复审失败测试，再实现代码；首轮前端红测为 4 项，随后定向测试 78/78 通过。
- `cargo test -p skillhub-application --test facade_relationship_governance`：33/33 通过。
- `cargo test -p skillhub-core --test import_conflicts`：4/4 通过。
- `pnpm --dir apps/desktop exec vitest run src/app/DiscoveryRoute.test.tsx src/features/import/ImportWizard.test.tsx src/features/import/nativeApi.test.ts src/features/import/ImportSummary.test.tsx src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`：82/82 通过。
- `pnpm --dir apps/desktop test -- --run`：147 个测试文件、1480/1480 通过。
- `pnpm --dir apps/desktop exec tsc --noEmit`、`pnpm --dir apps/desktop lint`、`pnpm --dir apps/desktop build`：通过。
- `SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings`：通过；绑定仅新增 `ImportItemStatus = "todo"`。
- `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets --all-features -- -D warnings`、`git diff --check`：通过。

### 剩余真实风险

- 本轮未进行真实 Windows/macOS 桌面人工验收；生产路由查询以 mock IPC（进程间通信）验证，真实服务端返回异常仍需在桌面验收中确认其错误呈现。
- 原件删除/迁移仍是独立高风险流程，本轮仅确认接管不会越界删除；未扩大到 Task 6 及后续任务。
