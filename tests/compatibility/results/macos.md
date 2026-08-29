# macOS 兼容性验收记录

状态：部分完成；文件级 Agent 验收通过，应用级门面和 Universal DMG 待补。

- 操作系统：macOS（需在 macOS 设备上执行）
- 验收提交：`3bd4ae3db5e2ab4d6537877b2f62ef417bfcb301`
- 记录日期：2026-08-29

## 已有证据

- macOS 本地 CI：10/10 通过；前端 307/307 测试通过，审计结果为 0 个漏洞。
- Codex CLI 和 Claude Code 的项目级目录、复制部署、符号链接、外部修改刷新和用户原文件保留均已通过文件级验收。
- 隔离测试覆盖权限失败、同名 Skill、嵌套 Skill、大小写和解除部署。
- Universal DMG：ARM64 编译成功；x86_64 因本机未安装 `x86_64-apple-darwin` target 且下载受网络阻塞，未生成 DMG。

## Agent 客户端

已验证客户端：

- OpenAI Codex CLI：项目级 `.agents/skills`，复制/符号链接/外部变化通过。
- Claude Code：项目级 `.claude/skills`，复制/符号链接/外部变化通过。

未安装或无法进行本地文件操作的客户端仍统一记录为：**未安装—未进行真实机验证**。ChatGPT Desktop 记录为：**无法判断—未进行文件接入验证**。

SkillHub 应用门面当前仍返回 `cli.not_connected`，因此以上是文件级事实，不等同于 SkillHub 应用级导入、部署或收集已完成。

## 待补验证

- 安装 `x86_64-apple-darwin` Rust target 后重新构建 Universal DMG，并记录产物摘要。
- 接入真实 `ApplicationFacade` 后，重新执行应用级导入、部署、收集和解除部署。
- 如需发布，补充 Finder 手动打开未公证应用的实际提示和 Draft Release 产物证据。
