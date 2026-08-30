# Plan09 Task16：可选 LLM 安全检查联调计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已冻结的 LLM 安全检查契约接入 ApplicationFacade，保持无配置时不调用、不落盘，并支持测试注入 runner 验证结构化结果。

**Architecture:** Facade 从 SQLite 读取已保存的 LLM profile，集中库版本只读物化为受限证据，使用可注入的 `LlmTaskRunner` 执行一次结构化安全任务，解析后写入独立 LLM 检查运行。异步 runner 在专用 Tokio 线程执行，避免阻塞 Tauri facade；未配置 profile 或 runner 时返回信息级 `llm.not_configured`。

**Tech Stack:** Rust、SQLite、Tokio、Tauri/Specta、Vitest。

## Global Constraints

- 不执行 Skill 内容中的命令、脚本、代码块或 MCP。
- LLM 检查与基础检查独立持久化、独立展示；LLM 不可用不改变基础检查结果。
- runner 只能接收集中库版本的文本证据和允许文件清单；不接受任意路径。
- 真实 HTTP runner 仅在用户配置 profile 和凭据后运行；测试使用注入 runner，不访问网络。

---

### Task 16.1：Facade LLM 安全检查命令

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `crates/skillhub-application/Cargo.toml`
- Test: `crates/skillhub-application/tests/facade.rs`

- [x] 先写失败测试：无 profile/runner 返回 `LlmNotConfigured` 且不生成检查运行；注入静态 runner 后 `RunLlmSafetyCheck` 和 `RecheckLlmSafety` 生成独立结果。
- [x] 接入 profile 读取、版本证据收集、静态 runner 注入和 LLM 结果持久化。
- [x] 运行 facade 定向测试、格式和整仓 Rust 测试。

### Task 16.2：桌面端 LLM 原生门面

**Files:**
- Modify: `apps/desktop/src/features/security/api.ts`
- Test: `apps/desktop/src/features/security/nativeApi.test.ts`

- [x] 新增类型化运行/重检函数，严格校验 `llm_safety_check_result` 返回类型。
- [x] 未配置错误保持结构化错误，不降级为基础检查失败。
- [x] 运行前端定向测试、TypeScript 和 ESLint。

### Task 16.3：双平台 CI 与文档收口

**Files:**
- Create: `docs/development/task-reports/plan-09-task-16-llm-safety-integration.md`
- Modify: `docs/development/当前开发状态.md`
- Modify: `docs/superpowers/plans/2026-08-30-skillhub-09-task-16-llm-safety-integration.md`

- [ ] 记录无配置边界、注入 runner 测试和安全限制。
- [ ] Windows CI 通过后提交推送，交由 macOS 在同一提交上只读复核。
- [ ] 双平台通过后勾选本计划并更新开发状态。
