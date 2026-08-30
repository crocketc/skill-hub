# Plan09 Task14：外部部署变化联调报告

## 完成内容

- ApplicationFacade 接入 `GetReconcilePlan` 查询及四类显式处理命令：收集修改、恢复版本、保留独立副本、忽略变化。
- 目标观察复用注册目标的物理身份和目录树哈希，区分 unchanged、modified、missing、ignored。
- 收集修改会把目标目录捕获为 SkillHub 新版本并更新部署关系的版本与哈希事实。
- 恢复动作只在显式调用时替换目标，并在替换前校验注册目标身份；不会自动重建缺失目标。
- 保留独立副本只解除 `managed` 标记，忽略动作记录当前观察哈希，不删除用户文件。
- 桌面端新增原生 reconcile 门面，查询与提交均使用生成的类型化 IPC。

## 测试

- `cargo test -p skillhub-application --test facade`：21/21 通过。
- `cargo test --workspace`：全部通过。
- 前端全量 Vitest：59 个测试文件、328 项测试通过。
- reconcile 原生门面定向测试：2/2 通过。
- TypeScript、ESLint、Rust 格式检查通过。
- Windows 本地 CI：10/10 全部通过；前端安全审计 0 个漏洞，生产构建通过。
- macOS 本地 CI：10/10 全部通过；前端安全审计 0 个漏洞，生产构建通过。
- macOS 专项测试：`facade reconcile_query` 1/1、`external_changes` 4/4、`reconcileNativeApi.test.ts` 2/2、TypeScript 通过。

## 安全边界

- 未变化目标不允许执行收集、恢复、保留或忽略操作。
- 目标目录缺失或注册物理身份变化时，不自动创建或覆盖目标。
- 恢复仅通过显式命令触发；应用层不提供任意路径操作。
- Agent 是否实际加载或执行 Skill 不由本模块推断。

## 待完成

- Task14 的 Windows/macOS 本地 CI 和专项测试均已收口；真实 Agent 是否执行 Skill 仍不属于本 Task 的验收范围。
