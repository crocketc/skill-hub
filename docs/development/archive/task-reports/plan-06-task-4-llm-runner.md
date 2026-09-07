# Plan 06 Task 4：安全 Provider 配置与固定 LLM 任务 runner

## 完成内容

- 增加 `LlmProfile`、`CredentialRef`、`LlmTaskKind`、`LlmTaskRequest`、`LlmTaskResponse` 和 `LlmTaskRunner` 核心契约。
- 只接受 HTTPS 且带主机的配置端点，限制超时和输入字节数；任务类型使用固定枚举。
- 增加无工具、固定温度、固定 JSON Schema response format 的 HTTP runner；只解析结构化 JSON，拒绝自然语言或非对象输出。
- 请求输入在构造 payload 前按当前凭据进行脱敏；凭据只通过引用从凭据存储取得，不写入配置仓储。
- 增加 Windows Credential Manager/macOS Keychain 的适配边界，并在原生安全存储尚未接入时提供进程级会话凭据 fallback；不会落盘。
- 增加 SQLite `llm_profiles` 表和仓储，保存 Provider、端点、模型、限制及 `CredentialRef`，不保存 Secret。

## 测试与验证

- `cargo test -p skillhub-adapters --test llm_runner`
- `cargo test -p skillhub-storage --test credential_redaction --test migrations`
- `cargo test --locked --workspace`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。Windows 链接器输出的既有提示不影响测试结果。

## 边界与后续接入

本 Task 只完成固定 runner、凭据边界和配置仓储，不执行任何 Skill 内容中的工具或脚本，也不实现 LLM 安全检查、语义重复分析、翻译或使用证据分析；这些由 Plan06 后续 Task 完成。Windows Credential Manager/macOS Keychain 的原生读写仍需在平台适配阶段接入，当前明确使用会话级 fallback。
