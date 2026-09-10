# 集中库初始化与生命周期实施报告

## 最终状态

Task 1–12 已按批准计划顺序完成。Rust/Tauri/React 的集中库生命周期已完成架构迁移：首次初始化在当前进程内从 Pending 原子切换到 Active；首次恢复仅在恢复文件、路径持久化均成功后发布 Active；已初始化入口改为只读重新发现与扫描；onboarding 专用重启 seam 已删除；绑定由 Specta 生成并校验。

当前分支：`feat/v0.2.0-product-completion`
实施基线：`23338766ed2621633649e8870174fcf08d2e0875`
交付限制：未 push、未 merge、未发布。真实 Windows/macOS 桌面人工验收只更新为“待人工复测”，没有用自动化结果替代 TC-US001-M02。

## Task 提交记录

| Task | 提交 | 范围摘要 |
| --- | --- | --- |
| 1 | `4439c7d` | 分离集中库 create/open-existing 语义、清单校验、可写探测与布局边界。 |
| 2 | `74d9b56` | 新增 Pending/Active `LibraryRuntime` 与 `LibraryContext`，实现一次性发布和共享快照。 |
| 3 | `49e9ac2` | 让 facade 与部署服务共享同一 runtime。 |
| 4 | `49670c6` | 将应用层集中库消费者迁移到原子 snapshot/context。 |
| 5 | `9e2b52e` | 增加 create/existing 激活命令、候选校验、数据库持久化后发布 Active。 |
| 6 | `0988874` | 增加首次恢复 prepare/commit，失败保持 Pending 并可改选目标。 |
| 7 | `06f703c` | 通过 Specta 暴露激活与首次恢复，移除 onboarding adapter 的 restart 暴露。 |
| 8 | `d26fc05` | 新建/已有库保存并继续，恢复分支先选目标库再选备份。 |
| 9 | `968b504` | 新增只读 RescanWizard，按 bootstrap snapshot 分流首次初始化与重新发现。 |
| 10 | `81534b2` | 删除 onboarding 专用 restart 文件、IPC handler、测试和旧 set-library-root seam。 |
| 11 | `eae1029` | 增加稳定错误码双语映射与首次初始化无重启 E2E 回归。 |
| 12 | 本最终提交 | 更新开发文档、人工复测状态、测试目录与本报告，并修正最终全量回归暴露的最小测试/静态检查问题。由于报告记录的是包含自身的提交，Task 12 的不可变哈希以最终 `git log -1` 为准，避免在文件内制造自引用哈希。 |

## Task 12 修改文件

本 Task 精确暂存并提交的文件为：

- `crates/skillhub-application/src/lib.rs`
- `crates/skillhub-application/tests/facade_update.rs`
- `crates/skillhub-storage/tests/library_layout.rs`
- `docs/development/开发状态-2026-09-10.md`
- `docs/development/自动化测试说明-2026-09-10.md`
- `docs/development/人工验收清单-2026-09-10.md`
- `docs/development/功能完成度与验收状态矩阵-2026-09-10.md`
- `.superpowers/sdd/2026-09-10-library-bootstrap-lifecycle-implementation-plan/progress.md`
- `.superpowers/sdd/2026-09-10-library-bootstrap-lifecycle-implementation-plan/implementation-report.md`

原子测试目录由生成脚本复核，未产生需要提交的额外差异。`test-results/`、构建产物、缓存和依赖目录均未暂存。

## 验证命令及结果

### Rust/Tauri

- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo test --workspace --all-features`：通过；包含集中库布局 11、runtime 4、应用 facade 80、desktop 22、首次恢复 2 等回归。
- `SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings`（PowerShell 等价写法）：通过；Specta 绑定无漂移。
- `cargo deny check advisories bans licenses sources`：通过；报告既有 duplicate crate 与 yanked `bisync` 警告，但无阻断错误。

### React/Playwright

- `pnpm --dir apps/desktop check`：通过。
- `pnpm --dir apps/desktop test --run`：108 个测试文件、773 个测试通过。
- `pnpm --dir apps/desktop build`：通过；仅有既有的大 chunk 优化警告。
- `pnpm test:e2e`：56/56 通过；测试完成后 webserver 清理进程未自然退出，命令由执行器中断，测试结果已完整产出。
- `pnpm test:e2e -- tests/e2e/onboarding.spec.ts`：2/2 通过。

### 仓库策略与文档

- `node scripts/generate_atomic_test_catalog.mjs`：生成器运行成功。
- `node scripts/verify_atomic_test_catalog.mjs`：349 个唯一测试、62 个 story、10 个全局规则通过。
- `node scripts/i18n-cjk-audit.mjs`：用户可见 CJK 命中 0；15 行 fixture 豁免已列明。
- `pnpm run verify:lifecycle`：59 个 package identity 通过。
- `pnpm test:release`：9/9 通过。
- `node scripts/verify_release_readiness.mjs`：PASS。
- `git diff --check`：通过。

### 本地 CI 状态

- `pnpm ci:local` 在获得网络权限后通过 Rust 格式、依赖策略、clippy、workspace 测试、前端依赖安装和 lifecycle policy。
- 同一 CI 在 `Frontend dependency audit` 阶段无法以项目配置的镜像 endpoint 执行，单独切换官方 npm registry 后得到真实审计结果：3 个 devDependency advisory（Vitest 2 个 moderate，js-yaml 1 个 high）。这些依赖升级不属于本次集中库生命周期计划，未擅自扩大范围或改锁文件。
- 覆盖率命令未纳入仓库脚本，当前依赖环境也未提供可用的 Vitest coverage provider；因此本次报告不虚构 80% 数值，使用上述单元/集成/E2E 全量结果作为证据，后续应单独补 coverage provider 与阈值门禁。

## 未解决问题、风险与阻塞

1. 必须在真实 Windows 与 macOS 桌面执行人工验收清单中的 TC-US001-M02/M03/M04/M05，尤其确认首次初始化、已有库、恢复失败重试和重新发现入口均无需重启；当前均为“待人工复测”。
2. `pnpm audit` 暴露既有 devDependency 风险：Vitest 需升级至 `>=4.1.11`，js-yaml 需升级至 `>=4.3.2`。本次未进行依赖升级，发布前应单独评估兼容性并更新锁文件。
3. 完整 Playwright 测试 56/56 已通过，但本机 webserver 清理存在不自然退出现象；不影响测试断言结果，后续可单独治理进程退出。
4. 构建仍报告若干超过 500 kB 的 chunk；与本次生命周期修复无关，保留为性能优化事项。

## 所有 Ruling

- 用户明确要求单一子代理，因此覆盖了默认的逐 Task 新鲜代理循环；仍通过 12 个独立提交、每 Task 测试和本台账保持隔离证据。
- 首次恢复目标保持 Pending，直到恢复文件与数据库路径持久化均成功；代价是失败目标保留安全重试痕迹，但不会让 Active runtime 或数据库指向未完成目标。
- Task 12 将 facade 更新测试的初始快照移动到 facade 构造之后，因为集中库初始化会按契约物化管理清单；代价是避免把预期初始化产物误判为业务数据变更，同时继续验证真实 skill 数据不被回滚触碰。
