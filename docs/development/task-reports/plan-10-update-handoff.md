# Plan 10 应用内更新功能交接记录

更新时间：2026-08-31

## 执行方式变更

由于子代理和独立 worktree 的额度、磁盘开销较高，后续由主 Agent 在当前 `main` 工作区顺序开发、测试和审查，不再为本计划创建新的子代理或 worktree。每个 Task 仍保持独立提交，并在完成后更新本记录和 SDD 进度账本。

## 当前 Git 状态

- 分支：`main`
- 当前提交：`2020e1e`（`feat: install updates and restart desktop app`）
- 本地相对 `origin/main`：领先 12 个提交，尚未推送
- 当前工作区：交接文档创建前无源码未提交修改
- 实施计划：`docs/superpowers/plans/2026-08-31-应用内更新功能实施计划.md`
- 进度账本：`.superpowers/sdd/2026-08-31-应用内更新功能实施计划/progress.md`

## 已完成任务

### Task 1：更新领域契约与确定性校验

- 提交范围：`d641416..5a74157`
- 状态：实现完成，经过两轮审查
- 覆盖：更新清单/资产/状态契约、SemVer、平台资产选择、大小与 SHA-256、Tauri/minisign 签名、官方 GitHub Release URL 白名单、Specta bindings
- 审查结论：通过

### Task 2：官方清单、资产下载与临时包管理

- 提交范围：`a88e796..3f7a15d`
- 状态：实现完成，经过两轮修复和审查
- 覆盖：流式下载、取消、429/5xx、大小限制、临时文件清理、sidecar 签名映射、无关 Release 资产跳过、已有目标文件保护、官方 URL 限制
- 审查结论：通过

### Task 3：ApplicationFacade 编排、策略缓存与回滚记录

- 提交范围：`072287e..7a6edb8`
- 状态：实现完成，经过一轮修复和审查
- 覆盖：策略与 24 小时缓存、准备下载元数据、网络禁用错误、待安装记录、一次性启动失败回滚、Skill/集中库数据不变
- 审查结论：通过；保留一个非阻断文档小项：报告文件未自包含最终提交哈希
- 重要边界：`DownloadApplicationUpdate` 当前只做元数据准备并返回安装阻止，不写入更新包正文；真实下载/安装由后续桌面层任务接管

### Task 4：Tauri Windows/macOS 安装、自动重启和启动探针

- 提交：`2020e1e`
- 状态：实现完成，任务级审查尚未完成
- 已验证：`cargo test -p skillhub-desktop updater`（7 项）、桌面 crate 全量测试、bindings、fmt、diff check
- 已实现：updater capability、staging 路径和后缀校验、Windows NSIS/macOS `.app.tar.gz` 区分、自动重启请求、启动探针状态
- 待审查风险：当前 updater public key 是测试 key，发布前必须与生产私钥匹配；确认未签名/ad-hoc 构建仍走官方发布页备用入口；确认 Tauri 配置不会在未签名构建中误启用可信安装

## 未完成任务

- Task 4：主 Agent 进行任务级规范/质量审查，必要时修复
- Task 5：设置页更新交互与 i18n
- Task 6：发布清单、签名资产和构建验证
- Task 7：Windows/macOS 双平台验收与收口

## 已知非阻断警告

- Windows 测试链接阶段有既有 linker stdout warning，但测试退出码为 0
- Cargo 存在重复依赖及 `bisync 0.3.0` yanked 警告
- Vite 可能报告大 chunk 警告

## 主 Agent 后续顺序

1. 审查 Task 4 完整差异，补齐任何规范或安全缺口，并运行桌面专项测试。
2. 在同一工作区实现 Task 5，先测试后代码，完成前端质量门禁。
3. 实现 Task 6 发布清单与签名预检，确保 DMG 仅用于首次安装、`.app.tar.gz` 用于 macOS 应用内更新。
4. 实现 Task 7 验收文档，分别在 Windows 和 macOS 运行本地 CI；真实安装若受签名/工具链限制，必须如实记录。
5. 全部任务完成后运行完整本地 CI、发布预检、bindings 漂移检查和 `git diff --check`，再决定推送/合并。

## 交接原则

- 不回滚或覆盖用户 Skill、集中库、数据库和个人配置。
- 不把私钥、API Key、更新包正文或个人路径写入仓库、日志或报告。
- 未签名/未公证版本不声称绕过 Windows/macOS 安全提示；保留官方发布页备用入口。
- 每个 Task 完成后立即更新本记录和 `.superpowers/sdd/.../progress.md`。
