# Plan 10 应用内更新功能交接记录

更新时间：2026-09-01

## 执行方式变更

由于子代理和独立 worktree 的额度、磁盘开销较高，后续由主 Agent 在当前 `main` 工作区顺序开发、测试和审查，不再为本计划创建新的子代理或 worktree。每个 Task 仍保持独立提交，并在完成后更新本记录和 SDD 进度账本。

## 当前 Git 状态

- 分支：`main`
- 当前提交：待本轮应用内更新闭环修复提交
- 本地与 `origin/main` 已同步
- 实施计划：`docs/superpowers/plans/2026-08-31-应用内更新功能实施计划.md`
- 进度账本：`.superpowers/sdd/2026-08-31-应用内更新功能实施计划/progress.md`（gitignore 内，仅本地）

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

### Task 5：设置页更新交互与 i18n

- 提交：`d8ec586`
- 状态：实现完成，已通过前端质量门禁和任务级审查（定向 13 项、全量 Vitest 346 项、ESLint、tsc、生产构建）
- 修改文件：`ApplicationUpdate.tsx`、`ApplicationUpdate.test.tsx`（新增）、`SettingsPage.tsx`、`SettingsPage.test.tsx`、`api.ts`、`i18n/zh-CN/common.json`、`i18n/en-US/common.json`
- 已实现：
  - `ApplicationUpdate` 改为按计划接口的纯展示状态机组件：props 为 `update`、`policy`、`state`、`progress` 及 `onCheck`/`onDownload`/`onInstall`/`onCancel`/`onRollback`/`onOpenRelease` 回调；覆盖全部 9 个 `UpdateState`
  - 安装按钮仅在 `ready_to_install`（完整性校验通过后）渲染；下载中显示 `role="progressbar"`（含 `aria-valuenow`）与取消按钮；`ready_to_install` 与 `rolled_back` 展示自动重启与系统安全提示文案（明确由 Windows/macOS 接管）
  - 开发者详情 `<details>` 展开源 URL 与 SHA-256；错误码经 `updateErrorKey`（字面量联合，TS 安全）映射为中英可操作提示；按钮均为原生 `<button>`，可键盘操作且有可访问名称
  - `api.ts` 新增 `UpdateState`/`UpdatePolicy`/`UpdateProgress`/`ApplicationUpdateOperations`；`SettingsSnapshot` 增加 `updateState`、`updatePolicy`；`nativeApplicationUpdateOperations` 绑定冻结契约（`check_application_update` 查询、`prepare_application_update`/`download_application_update`/`install_application_update` 命令、`rollback_application_update` 命令、`open_official_release`）
  - `SettingsPage` 内 `ApplicationUpdateCard` 持有阶段状态机，生产经 `facade.updates` 注入，测试/预览继续用假 facade
- 已验证：`pnpm exec vitest run src/features/settings/ApplicationUpdate.test.tsx src/features/settings/SettingsPage.test.tsx`（13 项）、`pnpm run check:frontend`、`pnpm run test:frontend`、`pnpm run build:frontend`
- 重要边界与已知限制：
  1. 检查结果现在会携带当前平台 manifest/platform；设置页可独立调用准备、下载和安装。缺少 manifest、平台不匹配或清单获取失败时，不发起下载并保留官方发布页兜底。
  2. 真实下载进度事件在冻结契约中没有载体，`progress` prop 已预留；取消下载同理（adapter 层支持取消 flag，但命令契约未暴露）。

#### Task 5 任务级审查结论

- 审查结果：通过。`ApplicationUpdate` 状态机覆盖 9 个状态，安装操作只在 `ready_to_install` 呈现，按钮具备键盘可访问名称；中英文资源、错误码映射和 mock facade 注入边界均符合 Task 5 计划。
- 验证结果：定向测试 13/13 通过；前端全量 Vitest 346/346 通过；ESLint、TypeScript 和生产构建通过；`git diff --check` 通过。
- 定向命令曾因 pnpm 在当前机器的可执行文件链接异常无法直接解析 `vitest`，随后使用 `apps/desktop/node_modules/.bin/vitest` 等价入口复核通过；该问题属于本机依赖链接，不是实现失败。

#### 契约缺口处理决定（已完成）

后续闭环修复采用最小契约扩展：检查服务在发现新版本后按当前平台获取并缓存匹配的 manifest/platform，`ApplicationUpdate` 通过 Specta 暴露两者；前端据此调用既有 prepare/download/install 命令，不复制版本选择或签名判断。

缺少 manifest、平台不匹配或清单获取失败时，前端不发起下载并保留官方发布页兜底；取消下载仍等待后续命令契约，避免伪造取消能力。

### 应用内更新闭环修复：manifest handoff

- 状态：已实现，待本轮提交后的双平台完整 CI 复核。
- 修改范围：`crates/skillhub-core/src/app_update/model.rs`、`crates/skillhub-application/src/update_service.rs`、`crates/skillhub-adapters/src/app_update/github_releases.rs`、`crates/skillhub-storage/tests/app_update_repository.rs`、`crates/skillhub-application/tests/facade_update.rs`、`apps/desktop/src/api/bindings.ts`、`apps/desktop/src/features/settings/api.ts`、`apps/desktop/src/features/settings/api.test.ts`。
- 已实现：检查结果携带当前平台 manifest/platform；设置页将清单转换为版本说明、资产 URL、SHA-256 和大小，并按 prepare→download→install 调用原生命令；无清单时保持可解释的失败和官方发布页回退。
- 测试：manifest facade 回归、绑定漂移、设置页原生操作测试已在 Windows 定向运行；完整前端和双平台 CI 需在提交后复核。

### Task 6：发布清单、签名资产和构建验证

- 状态：实现完成，任务级静态预检通过；真实生产签名仍待配置密钥后在 CI 验证。
- 修改范围：`.github/workflows/release.yml`、`apps/desktop/src-tauri/tauri.windows.conf.json`、`apps/desktop/src-tauri/tauri.macos.conf.json`、`scripts/generate_update_manifest.mjs`、`scripts/verify_release_readiness.mjs`、`scripts/verify_release_readiness.test.mjs`、`docs/release-process.md`、`docs/release-checklist.md`。
- 已实现：Windows/macOS 平台配置显式开启 `createUpdaterArtifacts`；macOS 同时保留 DMG 首次安装和 `app` updater 资产；工作流从 CI Secret 注入 Tauri 私钥，仅收集 `.nsis.zip`/`.app.tar.gz` 及 `.sig`；发布阶段生成固定 GitHub Release URL 的 `latest.json`，覆盖 Windows x64/ARM64 与 macOS x64/ARM64 条目。
- 安全门禁：工作流要求 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 和与仓库配置一致的 `TAURI_UPDATER_PUBLIC_KEY`；明确拒绝当前测试公钥用于正式发布。私钥不入库、不写日志、不进入发布产物。
- 验证：`node --test scripts/verify_release_readiness.test.mjs` 5/5 通过；`node scripts/verify_release_readiness.mjs --json` 通过；manifest 生成器覆盖平台资产、签名缺失和官方 URL 结构测试。
- 未解决问题：当前工作区仍使用测试公钥，尚未生成/配置生产密钥，因此不能声称已完成真实签名发布或应用内安装；取消下载事件仍未纳入冻结命令契约。

### Task 7：Windows/macOS 双平台验收与收口

- 状态：质量门禁验收通过；真实签名安装、自动重启和回滚取证待生产密钥与安装资产具备后补充。
- 当前基线：`b083d16`（包含 `d00d37f` 测试夹具竞态修复及最终验收记录），已推送并与 `origin/main` 同步。
- Windows：在 `956fb23` 修复 updater 单测竞态后，官方 npm registry 下 `./scripts/ci-local.ps1` 10/10 通过；Rust 测试、前端 61 个测试文件/346 项测试、前端安全审计 0 漏洞、生产构建均通过。镜像源已恢复为 `https://registry.npmmirror.com`。
- Windows 发布预检：`pnpm run verify:release` 通过；`node --test scripts/verify_release_readiness.test.mjs` 5/5 通过。
- macOS：在最新 `b083d16` 上完成 `./scripts/ci-local.sh` 10/10、发布预检 5/5 和 `facade_update` 9/9；前端安全审计 0 漏洞，未切换 npm 源。
- 回归修复：`956fb23` 为两个共享系统暂存目录的 updater 单测使用独立文件名；`d00d37f` 进一步隔离 facade 下载测试标识，消除并行清理导致的间歇性完整性/残留文件断言失败；生产安装逻辑未改变。
- 未验证：当前没有生产签名资产，因此未进行真实 NSIS/`.app.tar.gz` 安装、自动重启、失败回滚和 Windows SmartScreen/macOS Gatekeeper 行为取证；不把未签名版本描述为绕过系统安全审查。

## 未完成任务

- Task 5：完成（实现与任务级审查通过）
- Task 7：双平台质量门禁已通过；真实签名资产与安装取证仍待补充

## 已知非阻断警告

- Windows 测试链接阶段有既有 linker stdout warning，但测试退出码为 0
- Cargo 存在重复依赖及 `bisync 0.3.0` yanked 警告
- Vite 可能报告大 chunk 警告

## 主 Agent 后续顺序

1. 运行完整本地 CI、发布预检、bindings 漂移检查和 `git diff --check`，确认本轮闭环修复未引入回归。
2. 生成生产签名资产后，进行双平台真实安装、自动重启和失败回滚取证。

## 交接原则

- 不回滚或覆盖用户 Skill、集中库、数据库和个人配置。
- 不把私钥、API Key、更新包正文或个人路径写入仓库、日志或报告。
- 未签名/未公证版本不声称绕过 Windows/macOS 安全提示；保留官方发布页备用入口。
- 每个 Task 完成后立即更新本记录和 `.superpowers/sdd/.../progress.md`。
