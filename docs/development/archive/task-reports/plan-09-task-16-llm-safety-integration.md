# Plan 09 Task 16：可选 LLM 安全检查联调

## 状态

Windows 与 macOS 双平台复核已完成。

## 已完成内容

- `LocalApplicationFacade` 支持 `RunLlmSafetyCheck` 和 `RecheckLlmSafety`。
- 没有保存 LLM profile 或没有注入可用 runner 时，返回信息级 `llm.not_configured`；不会调用模型，也不会写入检查运行，基础检查结果不受影响。
- 只从集中库指定版本读取 Markdown 文件，限制允许文件清单、UTF-8 内容和单文件大小；不执行 Skill 中的命令、脚本、代码块或 MCP。
- 通过固定安全请求和结构化响应解析器生成独立 LLM 检查运行，保存模型标识、证据文件清单和 generation；复检使用递增 generation。
- runner 通过依赖注入提供，测试不访问网络；运行放在专用 Tokio 线程中，避免阻塞桌面门面。
- 桌面端新增类型化 `runNativeLlmSafetyCheck`，严格校验 `llm_safety_check_result` 返回类型，并区分首次运行与复检命令。

## 测试

- `cargo test -p skillhub-application --test facade`：25/25 通过。
- LLM 定向 facade 测试：2/2 通过，覆盖未配置不落库、配置运行、结构化发现项和复检代数递增。
- `apps/desktop/src/features/security/nativeApi.test.ts`：2/2 通过。
- TypeScript、ESLint、`cargo fmt` 和 `git diff --check`：通过。

## 未完成与边界

- 本 Task 不提供真实 HTTP runner 的凭据配置界面，不执行 Skill 内容，也不把 LLM 结果合并到基础检查。
- Windows 与 macOS 均在提交 `d2079b2` 上完成本地 CI 10/10；macOS 额外通过 LLM facade 2/2 和桌面端原生测试 2/2。macOS 首次使用根目录 Vitest 路径不适用，改用实际 `apps/desktop` 依赖路径后通过；未修改仓库。
