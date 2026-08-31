# Plan 10 应用内更新功能交接记录

更新时间：2026-08-31

## 执行方式变更

由于子代理和独立 worktree 的额度、磁盘开销较高，后续由主 Agent 在当前 `main` 工作区顺序开发、测试和审查，不再为本计划创建新的子代理或 worktree。每个 Task 仍保持独立提交，并在完成后更新本记录和 SDD 进度账本。

## 当前 Git 状态

- 分支：`main`
- 当前提交：`d4a50b7`（`fix: wire real update download and Tauri installer`）
- 本地与 `origin/main` 已同步
- 当前工作区：无源码未提交修改
- 已删除已确认干净的旧 worktree 及其 `target`/`node_modules` 缓存；释放约 75GB
- 保留两个含未提交改动的 worktree：`catalog-task-06`、`project-task-05`；未强制删除
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

- 提交：`2020e1e`，修正 `0626464`；任务级审查后修复 `d4a50b7`
- 状态：实现完成，任务级审查完成（发现并修复 3 个重要缺口）
- 已实现：updater capability、staging 路径和后缀校验、Windows NSIS `.nsis.zip` / macOS `.app.tar.gz` 区分、自动重启请求、启动探针状态
- 审查发现并修复（`d4a50b7`）：
  1. facade 的 `InstallApplicationUpdate` 原为硬编码 stub，desktop updater 模块无任何调用方，安装链路实际不通。现在 `UpdateService.install` 校验 ReadyToInstall 与 staging 文件后委托注入的 `ApplicationUpdateInstaller`，desktop `TauriUpdateInstaller` 经 Tauri updater 插件执行真实安装（插件自校验 minisign 签名；Windows NSIS 由插件退出进程，macOS 显式 `app.restart()`）。
  2. 计划接口 “run_with_facade 注入 updater capability” 原未实现。现在 `run_with_facade` 在 `setup` 中注入 `TauriUpdateInstaller::for_app`；无注入的 facade（测试）保持安装被阻止。
  3. `DownloadApplicationUpdate` 原不写包正文。现在经 Task 2 下载器流式写入 staging 路径，下载后以 `verify_downloaded_artifact`（大小/SHA-256/签名，含测试密钥对向量）校验，失败清理文件并将 pending 标记为 Failed。
- 新增验证：core `app_update` 19 项、application `facade_update` 9 项、desktop updater 10 项全部通过；clippy、fmt、bindings 漂移检查通过
- 已知边界：
  - 计划中的自由函数 `install_update(path)`/`restart_after_install()` 被注入 trait seam 取代（更符合“测试 facade 不启动真实安装器”边界）。
  - `tauri::test` mock runtime 在本 Windows 工具链上使测试进程崩溃（STATUS_ENTRYPOINT_NOT_FOUND），因此 desktop 侧以 `UpdaterPlugin` trait 注入假插件测试；真实安装行为留给 Task 7 双平台验收取证。
  - Tauri 插件安装时会再次访问同一官方端点做插件侧签名校验下载，与 facade 层 staged 包并存属已知重复下载代价，两层使用同一公钥。
  - 当前 updater public key 是测试 key，发布前必须与生产私钥匹配（见 Task 6）。
- 审查结论：通过

## 未完成任务

- Task 5：设置页更新交互与 i18n
- Task 6：发布清单、签名资产和构建验证
- Task 7：Windows/macOS 双平台验收与收口

## 已知非阻断警告

- Windows 测试链接阶段有既有 linker stdout warning，但测试退出码为 0
- Cargo 存在重复依赖及 `bisync 0.3.0` yanked 警告
- Vite 可能报告大 chunk 警告

## 主 Agent 后续顺序

1. 在同一工作区实现 Task 5，先测试后代码，完成前端质量门禁。
2. 实现 Task 6 发布清单与签名预检，确保 DMG 仅用于首次安装、`.app.tar.gz` 用于 macOS 应用内更新。
3. 实现 Task 7 验收文档，分别在 Windows 和 macOS 运行本地 CI；真实安装若受签名/工具链限制，必须如实记录。
4. 全部任务完成后运行完整本地 CI、发布预检、bindings 漂移检查和 `git diff --check`，再决定推送/合并。

## 交接原则

- 不回滚或覆盖用户 Skill、集中库、数据库和个人配置。
- 不把私钥、API Key、更新包正文或个人路径写入仓库、日志或报告。
- 未签名/未公证版本不声称绕过 Windows/macOS 安全提示；保留官方发布页备用入口。
- 每个 Task 完成后立即更新本记录和 `.superpowers/sdd/.../progress.md`。
