# Plan 09 Task 11：真实导入闭环

## 范围

本 Task 将桌面导入向导接入本地 `ApplicationFacade`，形成“本地目录发现 → 候选选择 → 确定性冲突分析 → 准备/提交 → 结果展示”的最小闭环。联网 URL、Git、npx 来源仍只解析并明确提示暂不支持，不执行外部命令。

## 已完成

- 增加 `DiscoverImportCandidates` 查询，复用 `SkillDetector` 只读扫描本地目录并返回候选。
- 接通 `AnalyzeImport` 查询，复用 SQLite 导入仓储返回确定性重复/同名分析。
- 接通 `PrepareImport`、`CommitImport`、`CancelImport`；复制导入写入集中库和目录式版本存储，保留用户原目录。
- 提交后任一阶段失败会清理 SQLite、版本对象、当前版本指针和便携清单，避免半成品；清理失败时返回需要恢复的结构化错误。
- 生成并校验 Specta TypeScript bindings，前端通过 `nativeImportFacade` 调用查询/命令，不手工复制 Rust 契约。
- 生产发现入口默认使用原生导入门面；测试仍可注入 Mock/Unavailable 门面。
- 前端将原生候选、所有权、冲突类型和导入决策映射到既有导入向导模型；批量提交按候选逐项执行并保留逐项失败结果。

## 验证

Windows 已完成定向验证：

- `cargo test -p skillhub-application --test facade`：13 项通过。
- `cargo test -p skillhub-core --test api_contract`：20 项通过。
- `cargo clippy --locked -p skillhub-application -p skillhub-storage --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`、`git diff --check`：通过。
- 前端 Vitest：56 个测试文件、321 项测试通过。
- 前端 TypeScript、ESLint：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。

Windows 完整本地 CI：10/10 通过。默认镜像不提供 pnpm audit 接口，首次运行在审计步骤停止；临时切换官方 npm 源后重跑通过，并恢复为原镜像。为修复 Windows Node 无法直接启动 `pnpm.cmd` 的环境差异，本 Task 同时将本地 CI 的固定命令改为在 Windows 使用平台 shell 解析 `.cmd` shim；命令列表仍是仓库固定内容，不接受用户命令文本。

macOS 已同步 `main@b983147` 完成完整本地 CI：10/10 通过，56 个测试文件、321 项测试通过，安全审计 0 个漏洞，生产构建通过。未修改代码、依赖或 lockfile。

## 已知边界

- 当前只对本地目录执行真实候选发现；远程来源获取仍属于后续适配器联调范围。
- 导入向导中的“接管/建立受管关联”决策已能进入原生命令映射，但后端当前只对已实现的复制、独立复制、复用和跳过路径执行；不支持的决策会返回逐项失败，不会静默改写文件。
- 前端当前无法向 Tauri 查询传递取消信号；取消会立即阻止向导状态更新，但正在进行的原生查询由运行时自然完成。
- 完整跨平台本地 CI 已通过；真实 macOS 应用级文件选择器和写入验收仍需后续产品验收，不作为本 Task 的强制门槛。
