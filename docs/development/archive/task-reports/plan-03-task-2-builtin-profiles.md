# Plan 03 Task 2：内置 Agent Profiles

状态：已完成

## 结果

- 增加 17 个研究型平台 profile，包含 Grok，不包含 Roo Code。
- 按 CLI、桌面端、IDE、TUI、ACP、云端/上传型产品拆分客户端边界。
- 仅保留有官方资料支持的软链接能力；未知能力使用稳定 machine code。
- 补齐 Antigravity、Cline、Cursor、Copilot、Grok 等兼容目录。
- 云端或上传型客户端使用空本地目标，不虚构可写目录。
- fixture 与实际声明路径做全等校验，内置 catalog 先经过严格 loader 验证。

## 关键提交

- 初始实现：`2266ed8`
- 修复提交：`38dbb57`
- 合并到 main：`1e0d7a5`

## 验证

- builtin profile tests
- profile schema tests
- workspace tests
- fmt、Clippy、bindings 和 `git diff --check`

## 后续依赖

Task 3 使用本 Task 的 profile 路径候选进行客户端发现，但不把目录存在等同于 Agent 已安装或可用。
