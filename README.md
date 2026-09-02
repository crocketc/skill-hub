# SkillHub

SkillHub 是一个面向 Windows 和 macOS 的本地 Skill 全生命周期管理工具。它把分散在不同 Agent、项目和个人目录中的 Skill 统一发现、整理、检查、版本化、部署和备份，让普通用户可以少理解目录细节，开发者也能保留对文件和部署方式的控制。

> 当前版本：`0.1.0`（早期发布）

## 主要能力

- 发现本机 Agent、项目和通用目录中的 Skill
- 将 Skill 导入统一的本地集中库，并保留来源和所有权信息
- 按名称、标签、来源、状态和 Agent/项目关系搜索与筛选
- 检测重复 Skill、同名冲突和已有部署关系
- 进行确定性的基础安全检查，并可选使用 LLM 做增强检查
- 记录版本、上游变化和外部修改，支持 Markdown 内容预览
- 将 Skill 复制或链接部署到一个或多个 Agent、项目目录
- 解除部署时保护集中库和用户原始文件
- 管理临时试用 Skill，并转正纳入集中库或删除
- 创建备份、生成可迁移数据和恢复操作
- 检查更新、下载签名更新包、安装后自动重启

SkillHub 负责管理 Skill 文件和部署关系，不保证目标 Agent 一定会执行某个 Skill，也不替用户安装 Skill 自身所需的 Python、ffmpeg、MCP 或其他外部工具。

## 下载与安装

请前往 [v0.1.0 Release](https://github.com/crocketc/skill-hub/releases/tag/v0.1.0) 下载对应平台的安装包。

### Windows

- Intel/AMD 设备下载 Windows x64 安装包。
- ARM 设备下载 Windows ARM64 安装包。
- 安装包使用当前用户安装模式，不需要管理员权限。

当前早期版本未购买 Authenticode 证书，Windows SmartScreen 可能显示“未知发布者”提示。请确认下载来源和文件校验值后，再由用户决定是否继续安装。项目不提供绕过系统安全提示的命令。

### macOS

- Intel 和 Apple 芯片设备均下载 macOS Universal DMG。
- DMG 仅用于首次安装，应用内更新使用独立的签名更新包。

当前版本使用 ad-hoc 签名且未进行 Apple 公证，首次打开时可能出现系统安全提示。请在确认来源后，在“系统设置 → 隐私与安全性”中允许打开，或通过 Finder 的“打开”操作确认。项目不提供绕过 Gatekeeper 的命令。

## 应用内更新

SkillHub 会从发布清单检查新版本。更新流程为：

1. 检查版本清单和当前平台是否匹配。
2. 下载对应平台的更新包。
3. 校验摘要和 minisign 签名。
4. 安装更新并自动重启应用。
5. 安装失败时保留回滚标记，并尝试恢复到上一版本。

如果清单不存在、平台不匹配或签名校验失败，应用不会安装未知文件，而是提示用户前往发布页手动获取版本。Windows 更新使用 `.nsis.zip`，macOS 更新使用 `.app.tar.gz`；DMG 不参与应用内更新。

## 支持范围

### 操作系统

- Windows 11：x64、ARM64
- macOS：Intel、Apple Silicon（Universal）

Linux 当前不在 V1 默认支持范围内。

### Agent 兼容性

项目已建立 Agent 目录和部署方式的兼容性模型，覆盖 Codex、Claude Code、Claude Desktop、Gemini CLI、Cursor、Cline、GitHub Copilot、Windsurf、OpenCode、Trae、Qoder、CodeBuddy、Comate、Kimi Code、OpenClaw、Hermes Agent、Grok Build、ZCode 等候选平台。

实际可用性取决于目标 Agent 是否安装、其版本和自身对 Skill 目录的处理方式。SkillHub 只识别目录、管理文件并执行复制/链接部署，不宣称目标 Agent 必然支持或执行某个 Skill。完整目录和适配边界见 [Agent 平台兼容性调研](docs/Agent平台兼容性调研.md)。

## 基本工作流

1. 首次启动时选择集中库位置；默认使用当前用户目录下的 `skillhub` 文件夹，也可以选择本地其他磁盘或网络存储目录。
2. 扫描本机已识别的 Agent 和项目 Skill 目录。
3. 在“发现与导入”中查看候选 Skill，处理重复、同名和来源关系。
4. 导入到集中库后，在技能库中添加标签、备注、版本和使用状态。
5. 选择目标 Agent 或项目，确认复制或链接方式后执行部署。
6. 在详情页查看 `SKILL.md` 和版本差异；删除或解除部署前查看影响范围。
7. 按需创建备份或迁移数据。

集中库是 SkillHub 管理的主副本。解除某个 Agent 或项目的部署，只移除 SkillHub 创建的部署目标，不删除集中库和用户原始文件。

## 数据与隐私边界

- SkillHub 的目录索引、部署关系、版本和操作记录保存在本机。
- 用户 Skill 内容、API Key、个人配置和集中库路径不会提交到本项目仓库。
- 联网搜索、来源获取和 LLM 检查均为可选能力；启用前应确认网络、服务商和数据发送范围。
- 基础安全检查不依赖 LLM，重点识别危险命令、疑似敏感信息和提示词注入等确定性风险。
- LLM 检查是独立的增强结果，不能替代基础检查，也不会自动修改 Skill。

## 已知限制

- 首次安装包尚未使用付费的 Windows Authenticode 或 Apple Developer ID/公证服务，系统可能显示安全提示。
- 普通用户无法保证所有 Agent 都有公开、稳定或可写的 Skill 目录；不可识别的平台可使用自定义目录兜底。
- 云盘、NAS 等网络存储属于预留能力，当前版本以本地文件系统管理为主，具体同步策略将在后续版本完善。
- 使用证据分析和运行时 Hook 属于实验/关联能力，不作为 SkillHub 核心可用性的前置条件。
- SkillHub 不负责安装 Skill 的运行时依赖，也不判断目标 Agent 是否真正执行了 Skill。

## 开发者指南

### 环境要求

- Rust stable，并包含 `rustfmt` 和 `clippy`
- `cargo-deny`
- Node.js 22（Node.js 24 也可用于本地检查）
- pnpm `11.21.0`

前端依赖位于 `apps/desktop`，Rust 工作区位于 `crates/` 和 Tauri 后端目录。安装依赖后，可以运行桌面开发入口：

```powershell
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop tauri dev
```

### 本地质量检查

Windows 11：

```powershell
.\scripts\ci-local.ps1
```

macOS：

```bash
chmod +x ./scripts/ci-local.sh
./scripts/ci-local.sh
```

跨平台统一入口：

```bash
node ./scripts/ci-local.mjs
```

检查包括 Rust 格式、依赖与许可证策略、Clippy、Rust 测试、前端依赖与安全审计、ESLint、TypeScript、Vitest 和生产构建。前端安全审计需要 npm audit 接口；某些镜像只支持安装而不支持审计，遇到此情况可临时使用官方 npm 源，完成后恢复原配置。详细步骤见 [本地 CI 使用说明](docs/本地CI使用.md)。

### 项目结构

```text
crates/skillhub-core/          跨平台领域模型、文件安全和核心规则
crates/skillhub-storage/       本地数据库与持久化
crates/skillhub-application/   应用流程、命令和查询门面
crates/skillhub-cli/           轻量 CLI 入口
apps/desktop/src-tauri/        Tauri 2 本地后端
apps/desktop/src/              React/Vite 前端
tests/                         跨平台夹具、集成测试和端到端测试
docs/                          需求、设计、架构、兼容性和发布文档
```

Rust 合约到 TypeScript 的 bindings 由 Specta 生成。修改命令或查询时，必须重新生成并执行漂移校验，不要手工维护接口副本。

## 文档索引

- [需求文档](docs/需求文档.md)
- [产品与交互设计](docs/产品与交互设计.md)
- [技术架构设计](docs/技术架构设计.md)
- [Agent 平台兼容性调研](docs/Agent平台兼容性调研.md)
- [本地 CI 使用说明](docs/本地CI使用.md)
- [发布流程](docs/release-process.md)
- [发布检查清单](docs/release-checklist.md)
- [依赖与供应链策略](docs/dependency-policy.md)

## 反馈与贡献

欢迎通过 GitHub Issues 报告问题或提出建议。提交问题时请尽量提供：

- 操作系统及版本
- SkillHub 版本
- 目标 Agent 及版本
- 可复现步骤和错误信息
- 是否使用复制部署、链接部署或自定义目录

请勿在 Issue、日志或提交中上传 API Key、密码、个人 Skill 内容或完整用户目录路径。

## English summary

SkillHub is a local, cross-platform Skill lifecycle manager for Windows and macOS. It discovers, imports, versions, checks, deploys, backs up, and updates Agent Skills while preserving user-owned files. The current `0.1.0` release is an early, unsigned/notarized distribution; verify release assets before installation and follow the operating-system security prompts.
