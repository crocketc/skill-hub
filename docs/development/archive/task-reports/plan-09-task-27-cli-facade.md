# Plan 09 Task 27：CLI 接入 ApplicationFacade

## 状态

已完成。代码提交为 `5d62d3b`，Clippy 修复提交为 `df9803e`；Windows 和 macOS 均完成验收。

## 已实现

- CLI 使用本机路径构造真实 `LocalApplicationFacade`，不再依赖仅测试用的记录 facade。
- 支持 `list`、`search`、`status`、`pending`、只读 `check` 和 `backup verify`。
- 保留 JSON、非交互和显式高风险授权边界；缺少数据库或配置时返回结构化可操作错误。
- 不执行任意命令、Skill 脚本、npx、在线来源或 LLM 输出。

## 验证

- Windows/macOS 本地 CI 均为 10/10。
- CLI 专项测试 7/7 通过，CLI Clippy、格式、类型检查和 `git diff --check` 通过。
- macOS 首次验收发现 `needless_return`，已以独立修复提交 `df9803e` 修正，复验 10/10 通过。

## 边界

CLI 的写入命令和完整 Agent/项目配置操作将在后续 facade 联调任务中继续接入；当前安全命令集不会绕过桌面端的路径和授权规则。
