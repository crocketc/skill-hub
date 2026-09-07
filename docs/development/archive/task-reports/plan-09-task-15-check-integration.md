# Plan09 Task15：检查运行与发现项处置联调报告

## 完成内容

- ApplicationFacade 已接通 `RunBasicCheck` 与 `RecheckBasic`，从集中库版本物化内容后运行确定性的 `BasicScanner`，结果持久化到 SQLite。
- 基础检查结果按版本和 generation 保存；重复重检不会覆盖历史运行。
- 检查发现项使用按运行隔离的存储键，避免不同检查运行的稳定发现 ID 发生冲突，同时对外保持原发现 ID。
- 已接通 `SetFindingDisposition`，支持基础检查和 LLM 检查的当前运行处置；高风险发现项改为 acknowledged/dismissed 时必须显式确认。
- 桌面端新增类型化 `setNativeFindingDisposition` 门面，严格校验返回结果类型。

## 测试

- Windows 本地 CI：10/10 全部通过；前端 59 个测试文件、329 个测试通过，安全审计 0 漏洞，生产构建通过。
- macOS 本地 CI：10/10 全部通过；前端 59 个测试文件、329 个测试通过，安全审计 0 漏洞，生产构建通过。
- ApplicationFacade 基础检查：1/1 通过。
- ApplicationFacade 高风险发现项处置：1/1 通过。
- `skillhub-application` facade：23/23 通过。
- `skillhub-storage` check repository：5/5 通过。
- 桌面端 `skill-detail/nativeApi.test.ts`：5/5 通过。
- TypeScript、ESLint、Rust 格式和工作区测试均通过。

## 安全边界

- 检查只读取指定集中库版本，不接受任意路径。
- 不执行 Skill 中的脚本、命令、代码块、MCP 或其他外部程序。
- 基础检查与 LLM 检查保持独立；本 Task 不负责 LLM runner 的配置和调用编排。
- 发现项处置只更新检查运行记录，不修改 Skill 内容。

## 收口状态

- Task15.1–15.2 已完成并通过 Windows/macOS 验收。
- LLM 检查运行、集中库删除、备份恢复和 CLI ApplicationFacade 写操作仍属于后续任务。
