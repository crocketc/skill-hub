# 个人开发文档本地化实施计划

> 本计划用于将个人研发过程资料从 Git 远端同步范围中移出，同时保留本地继续开发所需的完整文件。

**目标：** 远端只保留可运行源码、测试、构建配置、README 和必要的用户/维护者文档；个人需求、设计、计划、Task 报告和验收过程只保留在本机。

**方案：** 通过 `.gitignore` 固化本地文档目录和文件规则，再用 `git rm --cached` 仅移除 Git 索引、不删除工作区文件；同步修复 README 和 AGENTS.md 中对本地文档的公开引用。

**范围：** 不修改源码、业务行为、依赖、用户 Skill、API Key 或个人配置；不重写 Git 历史。

## 文档归类

- 仅本地：`.superpowers/`（3 个文件）。
- 仅本地：`docs/superpowers/`（42 个计划/规格文件）。
- 仅本地：`docs/development/`（70 个状态、交接和 Task 报告文件）。
- 仅本地：4 份个人基线文档：`docs/需求文档.md`、`docs/产品与交互设计.md`、`docs/技术架构设计.md`、`docs/Agent平台兼容性调研.md`。
- 仅本地：`docs/本地CI使用.md`，它是双设备开发者的本地验证操作手册，GitHub Actions 不依赖该文件。
- 仅本地：`tests/compatibility/results/` 下的个人设备验收记录。
- 远端保留：源码、测试夹具、CI、构建配置、`README.md`、`AGENTS.md`、安装说明、发布流程、依赖策略，以及兼容性验收模板。

## 执行步骤

### Task 1：固化忽略规则

**文件：**
- 修改：`.gitignore`

- [ ] 添加 `docs/superpowers/`、`docs/development/`、4 份个人基线文档、`docs/本地CI使用.md` 和 `tests/compatibility/results/` 的忽略规则。
- [ ] 保留现有 `.superpowers/`、构建产物、依赖缓存和 worktree 忽略规则。

### Task 2：修复公开引用

**文件：**
- 修改：`README.md`
- 修改：`AGENTS.md`
- 修改：`scripts/verify_release_readiness.mjs`
- 修改：`tests/compatibility/platform_smoke.md`（如模板仍引用本地基线文档）

- [ ] 删除或替换 README 中指向个人需求/设计文档及 `docs/本地CI使用.md` 的公开链接，只保留公开说明和使用入口；本地 CI 命令可保留为简短提示。
- [ ] 将 AGENTS.md 的权威文档列表改为远端实际存在的公开文档，移除对 `docs/本地CI使用.md` 和其他个人研发资料的强依赖。
- [ ] 从发布预检脚本的必需输入清单移除 `docs/本地CI使用.md`，保证干净克隆不依赖个人本地手册。
- [ ] 确保公开文档之间没有指向即将变为本地文件的链接。

### Task 3：移除 Git 索引、保留本地文件

**文件：**
- 从 Git 索引移除：`.superpowers/`、`docs/superpowers/`、`docs/development/`、4 份个人基线文档、`docs/本地CI使用.md`、`tests/compatibility/results/`

- [ ] 使用 `git rm --cached`，确认文件仍存在于工作区。
- [ ] 使用 `git check-ignore` 验证这些文件已被本地规则忽略。
- [ ] 不删除任何工作区文件，不触碰源码、依赖和用户数据。

### Task 4：验证和提交

- [ ] 运行 `node --test scripts/verify_release_readiness.test.mjs`。
- [ ] 运行 `git diff --check`。
- [ ] 检查 `git status --short`，确认只有预期的索引删除、忽略规则和公开引用变更。
- [ ] 提交：`chore: keep personal development docs local`。
- [ ] 推送 `main`，并记录 Git 历史仍保留旧文档这一事实。

## 风险与边界

- 本次操作不会从旧提交历史中删除文档；若未来需要历史不可见，需另行评估历史重写和强制推送。
- 其他设备拉取后不会自动获得这些个人文档；继续开发时应通过本地备份或明确的交接包传递，而不是依赖 Git 同步。
- `AGENTS.md` 保留在远端，确保新的 Agent 能理解源码边界和公开协作规则，不再依赖个人文档才能开始工作。
