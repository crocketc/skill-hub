# Plan 09 Task 9：详情页检查摘要接入

## 目标

将真实 ApplicationFacade 的基础检查和 LLM 检查结果映射到详情页状态摘要，保持两类检查独立，并在没有当前版本时避免无意义查询。

## 已完成

- 详情页原生门面读取 `GetSkill` 的当前版本指针。
- 当前版本存在时并行读取 `GetBasicCheckResult` 与 `GetLlmSafetyCheckResult`，分别映射到基础检查和 AI 检查状态。
- `not_checked` 映射为界面 `not_run`，`running` 映射为界面 `warning`；`passed` 与 `failed` 保持原义。
- 当前版本不存在时不调用检查查询，继续显示 `not_run`，不把 LLM 未配置当成异常。
- 新增前端回归测试覆盖基础/LLM 独立状态和调用次数。

## 验证

- `tsc --noEmit`：通过。
- `vitest` 原生详情门面测试：3/3 通过。
- Windows 前端全量测试、ESLint、TypeScript 和生产构建：待本 Task 提交前完成。
- Windows 前端全量测试、ESLint、TypeScript 和生产构建：通过，Vitest 55 个文件/316 项测试。
- macOS `./scripts/ci-local.sh`：通过 10/10；详情页原生门面测试通过，前端 55 个文件/316 项测试、安全审计和生产构建均通过。

## 后续

需要接入详情页检查面板的发现项列表、处置命令和运行检查流程；本 Task 只负责摘要状态读取，不写入检查结果。
