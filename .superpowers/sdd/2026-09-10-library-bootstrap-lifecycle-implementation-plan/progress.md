# SDD ledger — plan: docs/superpowers/plans/2026-09-10-library-bootstrap-lifecycle-implementation-plan.md

Base: 23338766ed2621633649e8870174fcf08d2e0875
Execution: one user-requested implementer subagent, model gpt-5.6-luna, reasoning high.

## Preflight dependency scan

| Producer | Consumer | Shared file/interface | Finding |
| --- | --- | --- | --- |
| Task 1 | Tasks 5-6 | `CentralLibrary` create/open semantics | Clean; activation and initial restore must use the split APIs. |
| Task 2 | Tasks 3-6 | `LibraryRuntime` / `LibraryContext` | Clean; later tasks depend on one-shot publish and snapshots. |
| Task 3 | Task 4 | facade and deployment backend runtime ownership | Clean; constructors must migrate before direct field accesses are removed. |
| Task 4 | Tasks 5-6 | all library-dependent application flows | Clean; activation must not ship while consumers still capture old paths. |
| Task 5 | Tasks 7-10 | activation command and desktop startup | Clean; generated binding and UI consume the finalized contract. |
| Task 6 | Tasks 7-8 | first-run restore commands | Clean after the plan's delayed-activation consistency correction. |
| Task 7 | Tasks 8-9 | generated bindings and onboarding adapter | Clean; bindings are generated, adapters are handwritten. |
| Task 8 | Tasks 10-12 | first-run UI and restart replacement | Clean; restart removal waits for save-and-continue coverage. |
| Task 9 | Tasks 11-12 | rescan route and settings entry | Clean; rescan does not call completion or activation. |
| Task 10 | Task 11 | removal of onboarding restart seam | Clean; updater restart remains outside this scope. |
| Task 11 | Task 12 | E2E and error-copy evidence | Clean; documentation consumes actual test evidence. |
| Task 12 | Final review | current development documents and full verification | Clean; manual status remains pending until real-device execution. |

Ruling: the user's explicit request for one subagent overrides the skill's default fresh-agent-per-task loop; the single implementer must still execute and self-review each task sequentially and maintain this ledger — cost if wrong: less independent per-task context isolation, mitigated by commits, tests, and controller review.
Ruling: candidate restore targets remain Pending until restore and persistence succeed, resolving the design's retry-versus-one-shot-activation tension — cost if wrong: candidate directories may retain safe retry artifacts, but no active runtime or database path points to them.

Task 1: complete（提交范围：拆分 `CentralLibrary::create` 与 `open_existing`，增加目录边界、清单校验与可写探测测试；测试结果：`cargo test -p skillhub-storage --test library_layout`，11 passed）。

Task 2: complete（提交范围：新增 `LibraryRuntime`/`LibraryContext`，覆盖 Pending、一次性发布、共享快照与并发激活；测试结果：`cargo test -p skillhub-application --test library_runtime`，4 passed）。

Task 3: complete（提交范围：facade 构造器与部署后端注入共享 `LibraryRuntime`，新增 Pending/Active 构造测试；测试结果：`cargo test -p skillhub-application --test facade facade_constructors_share_pending`，1 passed）。

Task 4: complete（提交范围：facade、部署/移除/对账、导入/版本/来源/备份/恢复/导出/项目装配等集中库消费者统一取得一次 `LibraryContext` 快照，删除旧字段访问；测试结果：`cargo test -p skillhub-application --tests`，首次迁移回归 71/75 通过，修正 Pending 非集中库业务兼容与活动库 undeploy 回归后目标用例通过；`rg` 旧字段访问为 0）。

Task 5: complete（提交范围：新增 `LibraryActivationMode`/`activate_library_root`，实现候选库校验→数据库持久化→Active 发布的单次事务，增加建议路径启动构造；测试结果：激活 create/existing/失败/锁定 4 个 facade 用例通过，`cargo test -p skillhub-desktop generate_bindings` 通过 Specta 生成校验；未提交生成绑定，留给 Task 7）。

Task 6: complete（提交范围：新增首次恢复 prepare/commit 命令，恢复与数据库路径持久化成功后才发布 Active，失败保持 Pending；测试结果：首次恢复目标与延迟激活 1 passed，失败保持 Pending/已初始化拒绝 1 passed，`cargo test -p skillhub-storage --test restore_migration` 2 passed）。
