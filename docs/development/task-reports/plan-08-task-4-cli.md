# Plan 08 Task 4：共享核心的轻量 CLI

状态：已完成并进入 `main`。

## 本 Task 完成内容

- 新增 `skillhub` 二进制和独立 CLI crate，命令集合限定在 SkillHub 已确认的文件管理能力：列表、搜索、扫描、导入、部署、解除部署、对齐、更新、检查、健康、待处理、备份、恢复、项目装配和状态。
- 统一 JSON envelope：包含 `schema_version`、`command`、`result_code`、`operation_id` 和结构化 `payload`。
- 非交互写操作要求 `--yes`；高风险解除部署额外要求 `--authorize-high-risk <fingerprint>`。
- 不提供任意 shell/exec 子命令；业务逻辑通过 `CommandFacade` 边界预留给桌面端同一 ApplicationFacade 接入。

## 验证

- `cargo test -p skillhub-cli`：通过。
- `cargo run -p skillhub-cli -- --help`：通过，帮助仅列出受支持命令。
- `cargo clippy -p skillhub-cli --all-targets -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- CLI 集成测试覆盖稳定 JSON 字段、命令白名单和高风险授权门槛。

## 明确边界

本 Task 完成 CLI 参数和输出边界，但当前 `UnconfiguredFacade` 只返回稳定的未接入结果码；真实数据库、ApplicationFacade、操作日志和命令执行将在后续联调 Task 接入。CLI 不绕过桌面端已有的安全检查和显式确认。
