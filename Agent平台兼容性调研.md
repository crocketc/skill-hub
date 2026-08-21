# SkillHub Agent 平台文件管理接入调研

> 文档状态：官方资料调研完成；按资料开发 profile，真机验证延后到开发完成后的测试阶段
>
> 调研基准日：2026-08-21
>
> 适用项目：SkillHub
>
> 支持目标：Windows、macOS；Windows 为首要验证平台

---

## 1. 调研目的

本文用于回答以下问题：

1. 哪些 Agent 平台确实具有可在本地观察或管理的 Skill。
2. 各平台的全局目录、项目目录、插件目录、内置 Skill 和同名优先级有何差异。
3. SkillHub 能否直接扫描、部署、解除部署、检测外部变化和提示刷新。
4. 哪些结论已有官方依据，哪些需要在开发完成后的 Windows、macOS 测试中验证。
5. 哪些平台适合提供预置文件管理 profile，哪些只能提供有限接入或自定义目录兜底。

本文只讨论 Skill 文件发现、目录关系、部署和生命周期管理，不承诺 Agent 已加载、能够调用或正确执行 Skill。开发阶段可以依据官方资料实现预置 profile，并标记“基于官方资料、待测试”；测试阶段再补充实际结果。全文中的“适配”均指文件管理接入，不表示运行时兼容认证。

### 1.1 范围边界

- 只研究可落到本地、可由 SkillHub 观察或控制的 Skill。
- 云端智能体、云端工作流、插件市场和 MCP 不因平台缺少本地 Skill 而被扩展为 SkillHub 的管理对象。
- 插件携带的 Skill 可以被观察和参与重复检测，但插件本身不纳入 SkillHub 的安装、升级和卸载职责。
- 调用次数只有在平台提供可靠本地证据时才记录；没有可靠证据时不推测。
- 不识别 Agent 版本、登录状态、项目可信状态、模型能力和运行时兼容性。
- `.agents/skills` 作为一级共享目录约定处理，但 Agent Skills 格式并不强制所有客户端支持该目录。
- 所有平台保留用户自选全局或项目 Skill 目录的通用兜底。
- Roo Code 已从候选池删除，不纳入本次调研和后续支持评估。

### 1.2 候选平台

本次共调研 20 个平台：

1. OpenAI Codex
2. Claude Code
3. Gemini CLI
4. Cursor
5. GitHub Copilot
6. Windsurf
7. Cline
8. OpenCode
9. Google Antigravity
10. TraeCode
11. 通义灵码（Qoder CN）
12. CodeBuddy Code
13. 文心快码 Comate
14. Kimi Code
15. ZCode
16. TraeWork
17. WorkBuddy
18. Kimi Work
19. OpenClaw
20. Hermes Agent

---

## 2. 证据与结论规则

### 2.1 证据等级

| 等级 | 含义 | 使用方式 |
|---|---|---|
| 官方明确 | 官方产品文档、官方帮助中心或官方更新日志直接说明 | 可以进入预置 profile，开发后再进行测试回归 |
| 官方源码推断 | 官方开源仓库能够推导，但产品文档没有承诺 | 只能作为验证线索，不能直接对用户承诺 |
| 待测试确认 | 官方资料缺失、互相矛盾或行为依赖具体客户端和操作系统 | 开发阶段显示“未确认”并允许自选目录兜底 |
| 不支持 | 官方明确不支持，或实机验证确认不可用 | SkillHub 显示“不支持”，不伪造能力 |

### 2.2 候选分类

| 分类 | 含义 |
|---|---|
| 完整文件管理接入候选（下文简称“完整适配候选”） | 本地目录、Skill 格式和主要层级规则已有较充分依据，可以实现完整 profile |
| 部分文件管理接入候选（下文简称“部分适配候选”） | 存在本地 Skill，但关键目录、优先级、刷新或客户端差异仍不完整 |
| 有限文件接入候选（下文简称“有限接入候选”） | 官方只确认上传包、市场安装或界面管理，未公开稳定本地目录；只能先提供包生成、手动导入和状态记录 |
| 暂不支持 | 没有可被本项目安全管理的本地 Skill 机制 |

分类仅代表当前调研成熟度，不代表开发版本划分，也不代表最终支持优先级。

---

## 3. 汇总结论

### 3.1 平台分类

| 分类 | 平台 |
|---|---|
| 完整文件管理接入候选 | Codex、Claude Code、Gemini CLI、Cursor、Windsurf、OpenCode、TraeCode、通义灵码（Qoder CN）、CodeBuddy Code、文心快码 Comate、Kimi Code、OpenClaw、Hermes Agent |
| 部分文件管理接入候选 | GitHub Copilot、Cline、Google Antigravity、ZCode |
| 有限文件接入候选 | TraeWork、WorkBuddy、Kimi Work |
| 暂不支持 | 当前无；Roo Code 已按产品范围决定移出候选池 |

以上分类允许按官方资料进入开发；未经测试时必须明确标记“基于官方资料”，不能宣传为运行时兼容或已验证可用。

### 3.2 核心发现

1. 多数编码 Agent 已采用以 `SKILL.md` 为入口的 Agent Skills 结构。
2. `.agents/skills` 正逐渐成为跨平台兼容目录，但各平台仍保留自己的原生目录和不同优先级。
3. 同名处理差异明显：有的平台选择高优先级版本，有的平台保留多个同名项，有的平台尚未公开规则。
4. “添加成功”不等于“Agent 已加载”。部分平台需要刷新、重开会话或重启客户端。
5. 内置 Skill、插件 Skill 和用户 Skill 必须区分所有权。SkillHub 不能覆盖或删除平台内置、插件管理的内容。
6. 软链接能力不能统一假设。Windows 的符号链接、目录联接与普通复制必须逐平台验证。
7. 本次没有发现任何平台公开稳定的“每个 Skill 调用次数”接口。平台日志或会话事件只能作为后续 hook 关联项目的候选证据。
8. TraeWork、WorkBuddy、Kimi Work 虽然支持本地 Skill 上传或安装，但尚不能证明存在稳定、公开、可由外部工具直接管理的目录。
9. 项目级目录并不统一：目录名称、项目根识别、父级或嵌套扫描、同名优先级和可信要求均可能不同。
10. 同一品牌的 CLI、桌面端和 IDE 插件需要分别保存客户端 profile；共享目录和规则相同时才合并为一个实际目标。

---

## 4. 平台能力总表

| 平台 | 本地 Skill | 全局/用户级 | 项目级 | 共享或兼容目录 | 同名规则 | 刷新方式 | 链接支持证据 | 调研分类 |
|---|---|---|---|---|---|---|---|---|
| Codex | `SKILL.md` 目录 | `$HOME/.agents/skills`；`~/.codex/skills` 需结合客户端验证 | 从当前目录到仓库根的 `.agents/skills` | 插件携带 Skill | 官方资料显示同名可同时出现，需按客户端复核 | 自动检测；App Server 可强制刷新 | 官方明确支持符号链接目录 | 完整适配候选 |
| Claude Code | `SKILL.md` 目录 | `~/.claude/skills` | `.claude/skills`，支持父级与嵌套发现 | `.claude/commands`、插件 `skills/` | Enterprise > Personal > Project；插件有命名空间 | Skill 文件监听；部分插件变化需 reload | 官方明确支持，Windows 有额外权限条件 | 完整适配候选 |
| Gemini CLI | `SKILL.md` 目录 | `~/.gemini/skills`、`~/.agents/skills` | `.gemini/skills`、`.agents/skills` | Extension `skills/` | Built-in < Extension < User < Workspace | `/skills reload` 或 `/skills refresh` | Extension link 明确；Skill link 实现待验证 | 完整适配候选 |
| Cursor | `SKILL.md` 目录 | `~/.cursor/skills`、`~/.agents/skills` | `.cursor/skills`、`.agents/skills` | 兼容 Claude、Codex 目录 | 未完整公开 | 启动时发现；热刷新待验证 | 未确认 | 完整适配候选 |
| GitHub Copilot | `SKILL.md` 目录 | `~/.copilot/skills`、`~/.agents/skills` 等 | `.github/skills`、`.agents/skills` 等 | Claude 兼容目录、插件 Skill | 未完整公开 | CLI/IDE/云端行为不同 | 未确认 | 部分适配候选 |
| Windsurf | `SKILL.md` 目录 | `~/.codeium/windsurf/skills` | `.windsurf/skills` | 与 Rules、Workflows、AGENTS.md 分离 | 未完整公开 | 当前会话刷新行为待验证 | 未确认 | 完整适配候选 |
| Cline | `SKILL.md` 目录，当前文档标记实验性 | `~/.cline/skills` | `.cline/skills` | `.clinerules/skills`、`.claude/skills` | Global > Project | 自动检测，当前会话行为待验证 | 未确认 | 部分适配候选 |
| OpenCode | 目录型 `SKILL.md` 或扁平 Markdown | `~/.config/opencode/skills` | `.opencode/skills` | `.claude/skills`、`.agents/skills`、显式目录、HTTP Catalog | 后注册来源覆盖前来源 | 本地热刷新待验证 | 未确认 | 完整适配候选 |
| Google Antigravity | `SKILL.md` 目录 | `~/.gemini/config/skills` | `.agents/skills` | 兼容 `.agent/skills` | 未公开 | 新会话/当前会话行为待验证 | 未确认 | 部分适配候选 |
| TraeCode | `SKILL.md` 目录 | `~/.trae-cn/skills` | `.trae/skills` | 可启用 `.agents/skills` | `.trae/skills` 高于 `.agents/skills`；全局/项目冲突仍需实测 | 界面刷新/重启行为需验证 | 未确认 | 完整适配候选 |
| 通义灵码（Qoder CN） | `SKILL.md` 目录 | IDE：`~/.lingma/skills`；CLI 使用 Qoder 配置根 | IDE：`.lingma/skills`；CLI：`.qoder/skills` | 插件 `skills/` | IDE 项目覆盖用户；CLI 规则需独立复核 | IDE 常需重启；CLI 可 reload | 未确认 | 完整适配候选 |
| CodeBuddy Code | `SKILL.md` 目录 | `~/.codebuddy/skills` | `.codebuddy/skills` | 插件 `skills/` | Project > User；插件使用命名空间 | 插件可 reload；独立 Skill 待验证 | 未确认 | 完整适配候选 |
| 文心快码 Comate | `SKILL.md` 目录 | `~/.comate/skills` | `.comate/skills`、`.agents/skills` | 可识别多个外部 Agent 目录 | 需实机确认完整优先级 | 界面/会话刷新待验证 | 未确认 | 完整适配候选 |
| Kimi Code | 目录型 `SKILL.md` 或扁平 Markdown | `$KIMI_CODE_HOME/skills`，默认 `~/.kimi-code/skills`；`~/.agents/skills` | `.kimi-code/skills`、`.agents/skills` | `extra_skill_dirs` | Project > User > Extra > Built-in | 官方示例要求重开会话 | 未确认 | 完整适配候选 |
| ZCode | `SKILL.md` 目录 | `~/.zcode/skills` | UI 支持项目导入，实际目录未公开 | 可从其他 Agent 复制或链接导入 | 未公开 | Settings 中手动 Refresh | 官方导入支持 Symlink | 部分适配候选 |
| TraeWork | 支持上传 Skill 包，稳定目录未确认 | 未确认 | 未确认 | 市场与账号同步行为待验证 | 未确认 | UI 管理 | 未确认 | 有限接入候选 |
| WorkBuddy | 支持本地 Skill 包和市场安装，稳定目录未确认 | 未确认 | 项目级能力存在，目录未确认 | 兼容 OpenClaw 社区包 | 未确认 | UI 管理 | 未确认 | 有限接入候选 |
| Kimi Work | 支持上传本地 Skill，稳定目录未确认 | 未确认 | 未确认 | 可能复用 Kimi Code 内核，但不能据此写目录 | 未确认 | UI/新会话行为待验证 | 未确认 | 有限接入候选 |
| OpenClaw | `SKILL.md` 目录 | `~/.agents/skills`、`~/.openclaw/skills` | `<workspace>/skills`、`<workspace>/.agents/skills` | Extra dirs、插件 Skill | Workspace > Project Agent > Personal > Managed > Bundled/Extra | 默认 watcher，下一次 Agent turn 生效 | 官方有显式信任与目标约束 | 完整适配候选 |
| Hermes Agent | `SKILL.md` 目录 | `~/.hermes/skills` | `.hermes/skills`、`.agents/skills`，需要项目信任 | `skills.external_dirs`、插件 Skill | Project > Local > External | 新会话、`--now` 或 reset；完整 watcher 待验证 | 推荐 external dirs；Skill 目录链接待验证 | 完整适配候选 |

---

## 5. 逐平台调研

### 5.1 OpenAI Codex

官方资料确认 Codex 使用目录型 `SKILL.md`，可以携带脚本、参考资料、资源和 `agents/openai.yaml`。当前官方体系同时出现跨 Agent 的 `.agents/skills` 与 Codex 自身的 Skill 安装位置，因此 SkillHub 不能只扫描一个固定目录，应同时维护官方已知候选目录并以本机实际存在位置和用户确认结果为准。

- 已确认：项目级 `.agents/skills`；用户级 `.agents/skills`；系统/插件 Skill；禁用配置；文件变化通知；符号链接目录。
- 源码线索：扫描深度和 App Server 的 `skills/list`、强制刷新能力。
- 必须验证：Windows 下 `.agents` 与 `.codex` 的实际发现关系、同名展示、目录联接、桌面端/CLI/IDE 的一致性。
- 调用证据：没有公开稳定的按 Skill 调用次数接口。
- 结论：完整适配候选。

主要来源：[Codex Build skills](https://learn.chatgpt.com/docs/build-skills)、[OpenAI Codex 官方仓库](https://github.com/openai/codex)、[Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。

### 5.2 Claude Code

Claude Code 的 Skill 体系最完整之一，支持个人、项目、企业和插件层级，并明确说明父级、嵌套目录、热变化和符号链接行为。

- 已确认：`~/.claude/skills`、`.claude/skills`、插件 `skills/`、旧 `.claude/commands` 兼容、层级优先级、启停和插件生命周期。
- 必须验证：Windows 符号链接权限、企业托管目录、同步到 Claude 账号的 Skill 与本地 Skill 冲突。
- 调用证据：没有官方按 Skill 调用次数 API。
- 结论：完整适配候选。

主要来源：[Claude Code Skills](https://code.claude.com/docs/en/slash-commands)、[Claude Code Plugins](https://code.claude.com/docs/en/plugins)。

### 5.3 Gemini CLI

Gemini CLI 明确区分 Built-in、Extension、User、Workspace 四层，并提供安装、链接、卸载、启用、禁用和刷新命令。

- 已确认：`.gemini/skills`、`.agents/skills`、层级优先级、Extension Skill、`/skills reload`、终端安装与卸载。
- 必须验证：Windows link 的实现、Workspace trust、禁用状态落盘位置、Extension 与普通 Skill 同名行为。
- 调用证据：会话内可以观察 `activate_skill`，但没有公开持久调用统计。
- 结论：完整适配候选。

主要来源：[Gemini CLI 管理 Agent Skills](https://geminicli.com/docs/cli/using-agent-skills/)、[Gemini CLI Skills 入门](https://geminicli.com/docs/cli/tutorials/skills-getting-started/)。

### 5.4 Cursor

Cursor 已采用 Agent Skills，并兼容 `.agents`、Cursor、Claude 和 Codex 多套目录。内置 Skill 和插件体系较丰富，但同名优先级、启用状态落盘位置和热刷新规则仍需实测。

- 已确认：用户级和项目级 `.cursor/skills`、`.agents/skills`，以及 Claude/Codex 兼容目录；内置 Skill；插件可携带 Skill。
- 必须验证：多目录同时存在时的遮蔽顺序、Customize 中禁用状态、Marketplace 安装位置、Windows 目录联接和当前会话刷新。
- 结论：完整适配候选，标记“已测试文件管理接入”前验证项较多。

主要来源：[Cursor Agent Skills](https://prod.cursor.com/docs/skills)、[Cursor Customize](https://prod.cursor.com/docs/customize-cursor)。

### 5.5 GitHub Copilot

GitHub Copilot 的 Agent Skills 同时服务 Copilot CLI、VS Code/JetBrains Agent Mode、Copilot App、Coding Agent 和 Code Review。目录明确，但不同载体的发现、刷新和本地状态并不完全一致。

- 已确认：用户级 `~/.copilot/skills`、`~/.agents/skills`；项目级 `.github/skills`、`.agents/skills`；兼容 Claude 目录；`gh skill` 安装方向。
- 必须验证：CLI 与 IDE 是否发现相同 Skill、云端 Agent 是否只读取仓库内容、同名规则、启停状态、活动会话刷新和链接行为。
- 结论：部分适配候选。适配时需要拆分“Copilot CLI/本地 IDE”和“GitHub 云端 Agent”能力，后者不属于本地目录部署目标。

主要来源：[GitHub 关于 Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)、[为 Copilot CLI 添加 Skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)。

### 5.6 Windsurf

Windsurf 官方已提供 Cascade Skills，而不只是 Rules。Workspace Skill 位于 `.windsurf/skills`，Global Skill 位于 `~/.codeium/windsurf/skills`；Skill 使用 `SKILL.md`、渐进式加载和自动/手动调用。

- 已确认：全局与工作区 Skill 目录、`SKILL.md`、辅助资源、自动调用、`@mention` 手动调用。
- 必须验证：同名全局/项目优先级、热刷新、符号链接、启用状态、插件或企业级 Skill 的落盘方式。
- 结论：完整适配候选。

主要来源：[Windsurf Cascade Skills](https://docs.windsurf.com/zh/windsurf/cascade/skills)。

### 5.7 Cline

Cline 已支持目录型 `SKILL.md`，但当前官方文档仍将 Skills 标记为实验性能力。它同时存在 VS Code 扩展和 CLI，用户目录在不同文档中可能出现差异。

- 已确认：`~/.cline/skills`、`.cline/skills`、部分 Claude 兼容目录、全局覆盖项目、单 Skill 开关。
- 必须验证：实验性开关、CLI 与扩展目录关系、状态落盘、热刷新、插件 Skill、符号链接和会话日志。
- 结论：部分适配候选。

主要来源：[Cline Skills](https://docs.cline.bot/customization/skills)、[Cline CLI Reference](https://docs.cline.bot/cli/cli-reference)。

### 5.8 OpenCode

OpenCode V2 同时支持目录型 `SKILL.md`、扁平 Markdown、本地额外目录和 HTTP Catalog，扫描与优先级规则较明确。

- 已确认：`~/.config/opencode/skills`、`.opencode/skills`、`.claude/skills`、`.agents/skills`、任意深度发现、显式来源、权限控制和覆盖顺序。
- 必须验证：本地热刷新、Windows/macOS 链接、HTTP Catalog 缓存、安全边界和机器可读发现列表。
- 结论：完整适配候选。

主要来源：[OpenCode V2 Skills](https://opencode.ai/v2/docs/skills)、[OpenCode Skills API](https://opencode.ai/v2/docs/api/skill/v2-skill-list)。

### 5.9 Google Antigravity

Google Antigravity 使用 Agent Skills 开放标准。项目默认目录已从早期 `.agent/skills` 转向 `.agents/skills`，全局目录为 `~/.gemini/config/skills`，但 IDE、CLI 和不同版本的全局路径仍存在历史差异。

- 已确认：项目 `.agents/skills`、全局目录、`.agent/skills` 向后兼容、`SKILL.md` 和渐进式加载。
- 必须验证：IDE 与 CLI 是否共享目录、同名优先级、插件 Skill、启停、热刷新、符号链接。
- 结论：部分适配候选。

主要来源：[Google Antigravity Skills](https://antigravity.google/docs/skills)、[Antigravity Skills Codelab](https://codelabs.developers.google.com/getting-started-with-antigravity-skills)。

### 5.10 TraeCode

TraeCode 官方文档已明确使用 `SKILL.md`，支持全局、项目、内置、启用/禁用、上传导入以及 `.agents/skills` 兼容。

- 已确认：项目 `.trae/skills`；Windows/macOS 全局 `~/.trae-cn/skills`；可选 `.agents/skills`；`.trae` 同名优先于 `.agents`；内置 Skill；UI 创建、导入、启停和删除。
- 必须验证：全球版与中国版路径差异、全局与项目同名顺序、禁用状态文件、热刷新、软链接以及 TraeCode/旧 TRAE IDE 的迁移。
- 结论：完整适配候选。

主要来源：[TraeCode 技能文档](https://docs.trae.cn/ide_skills)、[TraeCode 更新日志](https://www.trae.ai/changelog)。

### 5.11 通义灵码（Qoder CN）

原“通义灵码”已进入 Qoder CN 品牌体系，但 IDE 仍使用 `.lingma` 目录，CLI 使用 `.qoder` 和 Qoder 配置根。SkillHub 必须将 IDE 与 CLI 建模为同一品牌下的两个适配 profile，不能混用目录。

- 已确认：IDE 用户级 `~/.lingma/skills`、项目级 `.lingma/skills`、项目覆盖用户；CLI 项目级 `.qoder/skills`；插件携带 Skill；内置 Skill；CLI reload 与禁用控制。
- 必须验证：Windows/macOS 的 Qoder 配置根、IDE 是否继续只认 `.lingma`、CLI 用户目录、IDE/CLI 同时安装时的重复发现和链接支持。
- 结论：完整适配候选，但必须拆分 IDE 与 CLI profile。

主要来源：[Qoder CN Skills](https://help.aliyun.com/zh/lingma/qoder-cn/user-guide/skills)、[Qoder CN 插件](https://help.aliyun.com/zh/lingma/plugin-hidden-release)。

### 5.12 CodeBuddy Code

CodeBuddy Code 的 Skills、插件、启停与本地设置体系较完整，并明确区分编程产品和 WorkBuddy 办公产品。

- 已确认：`~/.codebuddy/skills`、`.codebuddy/skills`、项目覆盖用户、插件 `skills/`、`skillOverrides`、插件 reload 和 Marketplace 生命周期。
- 必须验证：Windows/macOS 路径、嵌套 Skill ID、独立 Skill 热刷新、符号链接、内置 Skill 清单和机器可读发现结果。
- 结论：完整适配候选。

主要来源：[CodeBuddy Code Skills](https://www.codebuddy.ai/docs/cli/skills)、[CodeBuddy 插件](https://www.codebuddy.cn/docs/cli/plugins-reference)。

### 5.13 文心快码 Comate

Comate 已正式支持 Agent Skills，不应与其旧有 Rules 机制混淆。官方文档明确给出 `.comate/skills`、`.agents/skills`、用户级目录、内置 Skill、外部 Agent 兼容目录和 `/find-skills`。

- 已确认：用户级 `~/.comate/skills`；项目级 `.comate/skills`、`.agents/skills`；`SKILL.md`；内置 `create-skill` 等系统 Skill；可读取多个外部 Agent 目录；手动和自动调用。
- 必须验证：20 多种外部目录的实际清单和优先级、Comate IDE/VS Code/JetBrains 是否一致、热刷新、启停状态、链接与插件 Skill。
- 结论：完整适配候选。

主要来源：[文心快码 Comate Skills](https://cloud.baidu.com/doc/COMATE/s/Nmma28iqe)、[Comate 4.0 发布说明](https://cloud.baidu.com/doc/COMATE/s/xmm4hx69k)。

### 5.14 Kimi Code

Kimi Code 支持目录型和扁平型 Skill，兼容 `.agents/skills`，支持项目、用户、额外目录和内置层级。

- 已确认：默认 `~/.kimi-code/skills`、`.kimi-code/skills`、用户和项目 `.agents/skills`、`extra_skill_dirs`、Project > User > Extra > Built-in、Flow Skill 和手动/自动调用。
- 必须验证：Windows/macOS 安装路径、扁平与目录型冲突、Flow Skill 是否需要特殊类型标记、当前会话刷新、插件格式和链接行为。
- 结论：完整适配候选。

主要来源：[Kimi Code Agent Skills](https://www.kimi.com/code/docs/kimi-code-cli/customization/skills.html)、[Kimi Code 使用 Skills](https://www.kimi.com/en/help/features/use-skills-in-code)。

### 5.15 ZCode

ZCode 已公开用户级 Skill 目录，并在 UI 中支持搜索、启停、刷新以及从其他 Agent 复制或链接导入。项目级导入虽然存在，但目录未公开。

- 已确认：`~/.zcode/skills`、`SKILL.md`、启用/禁用、Refresh、插件 Skill、从其他 Agent Symlink/Copy 导入。
- 必须验证：项目级实际路径、同名优先级、扫描深度、链接源变化、外部 Agent 探测清单和调用日志。
- 结论：部分适配候选。第一阶段只应安全管理已确认的用户级目录。

主要来源：[ZCode Skill](https://zcode.z.ai/en/docs/skill)、[ZCode Plugin](https://zcode.z.ai/cn/docs/plugin)。

### 5.16 TraeWork

TraeWork 是独立的办公 Agent 产品，不能直接套用 TraeCode 的 `.trae/skills` 规则。当前官方产品资料确认其支持 Skill 使用和本地/云端工作形态，但没有公开稳定的 Skill 目录和文件刷新规则。

- 已确认：桌面、Web、移动形态；Work/Code 模式；界面中可使用和上传 Skill 的产品能力。
- 未确认：全局目录、项目目录、优先级、热刷新、链接、卸载落盘和调用记录。
- 结论：有限接入候选。实机确认目录前，只提供 Skill 包生成、上传指引和人工安装记录。

主要来源：[TraeWork 官方产品页](https://www.trae.ai/work)、[TRAE 官方社区 TraeWork Skill 指南](https://forum.trae.cn/t/topic/32832)。后者只作为操作线索，不作为稳定目录承诺。

### 5.17 WorkBuddy

WorkBuddy 官方确认支持本地 Skill 包、技能市场、查找、创建、启停、卸载、批量卸载和版本更新，但尚未公开稳定本地目录。

- 已确认：上传本地 Skill 包、市场安装、启用/关闭、搜索、卸载、批量操作、安全扫描和版本提示。
- 未确认：安装后的本地目录、项目目录、同名规则、热刷新、链接和调用记录。
- 结论：有限接入候选。SkillHub 可以生成兼容包与安装说明，但不能在没有实机证据时直接写入 `.workbuddy` 等猜测目录。

主要来源：[WorkBuddy 技能](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)、[WorkBuddy 更新日志](https://www.codebuddy.cn/docs/workbuddy/Changelog)。

### 5.18 Kimi Work

Kimi Work 是基于 Kimi Code 内核的本地办公 Agent，官方明确支持安装、使用和上传本地 Skill，但没有公开它是否直接读取 Kimi Code 的目录。

- 已确认：Windows 10+、Apple Silicon macOS 12+；本地 Agent；Skill 面板；第三方和本地 Skill 上传。
- 未确认：是否读取 `~/.kimi-code/skills`、项目目录、插件兼容、启停落盘、热刷新、链接和调用记录。
- 结论：有限接入候选。Kimi Code 的适配规则不能自动继承给 Kimi Work。

主要来源：[Kimi Work 产品介绍](https://www.kimi.ai/zh-hans/help/kimi-work/overview)、[Kimi Skills](https://www.kimi.com/zh-cn/help/features/what-are-skills)。

### 5.19 OpenClaw

OpenClaw 的本地 Skill 层级、扫描深度、安装更新、启停、链接安全和热刷新规则非常完整，但层级比一般编码 Agent 更复杂。

- 已确认：Workspace、Project Agent、Personal Agent、Managed、Bundled、Extra dirs 和插件来源；最多六层扫描；完整优先级；禁用；安装、更新、卸载；链接目标信任；默认 watcher。
- 必须验证：Windows/macOS state dir、所有层级的同名遮蔽、插件/extra dirs、链接信任失败提示和调用日志。
- 结论：完整适配候选，但适配器复杂度较高。

主要来源：[OpenClaw Skills](https://docs.openclaw.ai/skills)、[OpenClaw 官方仓库](https://github.com/openclaw/openclaw)。

### 5.20 Hermes Agent

本文中的 Hermes 指 Nous Research Hermes Agent。它具有用户、项目、外部目录、插件、官方 Hub、信任和安全扫描机制。

- 已确认：`~/.hermes/skills`、项目 `.hermes/skills` 和 `.agents/skills`、项目 trust、`skills.external_dirs`、Project > Local > External、Hub 安装更新卸载和插件命名空间。
- 必须验证：Windows 原生实际根目录、external dirs 热刷新、Skill 目录链接、调用日志以及不同 profile 的启停状态。
- 结论：完整适配候选。

主要来源：[Hermes Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)、[Hermes Working with Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills)、[Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent)。

---

## 6. 跨平台适配约束

### 6.1 不能使用统一的同名覆盖规则

SkillHub 需要为每个平台保存独立的来源层级和优先级规则，至少区分：

- 内置 Skill。
- 插件或扩展 Skill。
- 用户级 Skill。
- 项目级 Skill。
- 跨平台 `.agents/skills`。
- 平台原生兼容目录。
- 额外显式目录。

当官方规则未知时，只能显示“无法判断”，不能自行假定项目级一定覆盖全局级。该推算只形成目录关系中的“优先候选、较低优先级副本、可能共存或无法判断”，不声称 Agent 实际已加载。

### 6.2 跨 Agent 共享目录可能制造隐形重复

Cursor、Gemini CLI、GitHub Copilot、OpenCode、TraeCode、Comate、Kimi Code、OpenClaw、Hermes 等都可能读取 `.agents/skills`。同一个实体因此可能被多个 Agent 同时发现，也可能被同一 Agent 从原生目录和兼容目录重复发现。

SkillHub 应以真实路径、规范化路径、文件身份和内容哈希联合判断是否为同一实体，不能仅凭 Skill 名称计数。

`.agents/skills` 的部署语义必须区分：

- “仅添加到选定 Agent”优先使用 Agent 专属目录。
- “共享给所有兼容 Agent”才优先使用 `.agents/skills`。
- 共享实体仍被其他 Agent 引用时，解除单个 Agent 关系不得直接删除文件。
- Agent 专用变体内容不一致时不能共用同一份共享部署。

### 6.3 插件 Skill 默认只读

插件 Skill 的文件生命周期由插件管理器负责。SkillHub 可以：

- 扫描和展示。
- 参与名称、内容和功能重复检测。
- 展示插件来源与只读原因。
- 允许用户复制导入为独立 Skill。

SkillHub 不应直接更新、删除或覆盖插件中的原件。

### 6.4 刷新策略必须平台化

平台刷新至少分为：

- 自动热加载。
- 提供刷新命令。
- 需要重开会话。
- 需要重启客户端。
- 未确认。

部署完成后的结果页应给出对应动作，而不是统一显示“已立即生效”。

### 6.5 软链接策略必须经过实测

官方证据较充分的平台包括 Codex、Claude Code、ZCode 和 OpenClaw；其他平台不能仅因底层文件系统支持链接就宣称 Agent 支持。

Windows 必须分别验证：

- 普通目录复制。
- 目录符号链接。
- Directory Junction。
- 链接目标移动、删除和权限不足。
- Agent 是否跟随链接扫描。
- 文件 watcher 是否能感知链接目标变化。

### 6.6 调用统计不能作为首批适配承诺

本次官方资料调研没有发现稳定的跨平台按 Skill 调用次数接口。可获得的证据主要是：

- 会话中的 Skill 工具调用事件。
- 平台本地日志或历史记录。
- 手动调用命令。
- SkillHub 自身部署记录。

这些证据覆盖不完整，且不同平台差异很大。SkillHub 不提供人工“用过、有帮助、没有效果”反馈，也不把无证据平台显示为调用次数零。需求文档中“使用证据覆盖情况”和关联 runtime hook 项目的决定仍然成立。

### 6.7 初始化与项目扫描边界

- 初始化只扫描集中库、`~/.agents/skills`、已发现客户端的已知用户级目录、可访问的内置或插件目录和用户自选目录，不遍历全盘。
- 未注册项目不自动扫描；项目注册后按对应 Agent 的原生目录、`.agents/skills`、父级和嵌套规则扫描。
- 用户可以选择一个上级文件夹有限发现候选项目，结果先预览，不读取 Agent 对话或项目历史。
- 仅发现 `.agents/skills` 不能推断项目正在使用哪些 Agent，项目与 Agent 关联由用户确认。
- 单仓库中的嵌套 Skill 默认作为项目子目录范围，不自动创建新项目；父子项目可以重叠，但同一实体只识别一次。

### 6.8 客户端存在与文件可用性边界

- 发现应用程序、CLI 或官方安装记录时只表示客户端存在；只发现目录时显示“发现相关目录”。
- 不读取 Agent 版本，不判断登录、项目可信、模型能力和运行时兼容性。
- 部署成功只表示文件已放入目标目录并建立管理关系，不表示 Agent 已加载或能够调用。
- 平台自身的项目信任无法可靠持续观察，不建立“未授权”状态；只在故障排查中提供可能原因。

---

## 7. 开发完成后的真机测试计划

当前不要求在开发前或开发过程中安装全部平台。开发先按官方资料实现 profile，并依赖自定义目录兜底；以下测试在功能开发完成后执行，用于修正目录规则和记录已测试范围，不用于判断 Skill 功能是否正确。

### 7.1 验证批次建议

| 顺序 | 平台 | 原因 |
|---|---|---|
| 第一批 | Codex、Claude Code、Gemini CLI、Cursor、TraeCode、通义灵码、CodeBuddy Code、文心快码 Comate、Kimi Code | 用户覆盖面高，目录较明确，能够尽早验证通用适配框架 |
| 第二批 | Windsurf、OpenCode、OpenClaw、Hermes Agent | 本地能力完整，但层级、额外目录或链接安全更复杂 |
| 第三批 | GitHub Copilot、Cline、Google Antigravity、ZCode | 关键规则或客户端差异尚未完全公开 |
| 第四批 | TraeWork、WorkBuddy、Kimi Work | 需要先确认是否存在稳定、公开、可由外部管理的目录 |

### 7.2 每个平台的统一验证用例

1. 安装平台并记录操作系统、安装方式、客户端形态和用户数据根目录；不把 Agent 版本识别做成产品功能。
2. 通过平台 UI 创建一个用户级 Skill，反查实际文件位置。
3. 通过平台 UI 创建一个项目级 Skill，反查实际文件位置。
4. 手工放入最小合法 Skill，验证平台发现结果。
5. 放入缺少 frontmatter、名称不匹配、超长描述和嵌套过深的 Skill，验证诊断行为。
6. 构造用户级、项目级、内置、插件和兼容目录同名 Skill，验证实际目录优先关系。
7. 验证平台启用、禁用、删除和恢复后的文件变化。
8. 修改、移动、重命名和删除已加载 Skill，验证刷新和外部变化行为。
9. 分别验证复制、符号链接和 Windows Directory Junction。
10. 验证 Skill 中包含脚本、引用、资源、环境变量说明时的读取行为。
11. 在不解析原始会话内容的前提下，确认平台是否提供可合法取得的 Skill 调用事件；没有则记录为无可靠证据。
12. 平台更新后按测试流程复核目录、优先级和配置是否变化，但 SkillHub 不主动识别 Agent 版本。

### 7.3 已测试文件管理接入条件

平台 profile 只有同时满足以下条件，才可以标记为“已测试文件管理接入”：

- Windows 至少完成全量验证。
- macOS 完成核心目录、部署、解除部署、冲突和刷新验证。
- 官方资料与实机行为之间的差异已有明确记录。
- 可以可靠识别用户自有、平台内置、插件管理和未知来源。
- 部署和解除部署不会覆盖或删除非自有内容。
- 同名和目录关系规则可以解释；无法解释的部分会在产品中明确显示“无法判断”。
- 失败时存在可执行的恢复方案。

该标记仍不代表 Skill 功能验证、Agent 运行时兼容认证或安全认证。

---

## 8. 对后续工作的影响

### 8.1 平台适配需要 profile 化

同一品牌可能存在多个客户端和目录，例如：

- Codex Desktop、CLI、IDE。
- GitHub Copilot CLI、VS Code/JetBrains、本地与云端 Agent。
- 通义灵码/Qoder CN IDE 与 CLI。
- CodeBuddy Code 与 WorkBuddy。
- TraeCode 与 TraeWork。
- Kimi Code 与 Kimi Work。

产品层可以统一展示品牌，底层必须按客户端 profile 保存能力和规则。

### 8.2 开发优先级应由依赖关系决定

本项目不做功能版本裁剪，但实现顺序仍应先完成：

1. 统一的 Skill 身份、路径和来源模型。
2. 平台 profile 与能力声明。
3. 只读扫描、所有权和目录关系判断。
4. 部署、解除部署、冲突处理和恢复。
5. 刷新、外部变化、插件观察和复杂层级。
6. 调用证据与全局 Skill 分析等依赖平台数据的功能。

### 8.3 仍需维护的平台资料

平台规则变化频繁。正式开发后应维护：

- 适配规则版本。
- 最后官方资料检查日期。
- 最后真机测试的客户端形态、操作系统和环境说明。
- 已知差异与未确认能力。
- 需要重新验证的触发条件。

---

## 9. 当前结论

20 个候选平台均存在继续调研或文件管理接入价值，但接入深度不同：

- 13 个平台可以按官方资料实现完整文件管理 profile。
- 4 个平台可以先实现部分文件管理 profile，未知规则显示“无法判断”并保留自定义目录兜底。
- 3 个办公型 Agent 暂时只做包生成和手动安装辅助，确认稳定本地目录前不直接写入其内部数据。
- 没有平台能够仅凭官方资料提供可靠的按 Skill 调用次数统计。
- Roo Code 已移出候选范围，不再占用后续调研和开发资源。

下一步进入功能优先级、产品与技术设计，并按本文实现平台 profile。真机测试在功能开发完成后执行，用于修正目录和部署规则；所有未覆盖平台继续使用用户自选 Skill 目录兜底。
