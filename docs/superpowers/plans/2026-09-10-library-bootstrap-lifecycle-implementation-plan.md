# 集中库初始化与生命周期实施计划

日期：2026-09-10
依据：`docs/superpowers/specs/2026-09-10-library-bootstrap-lifecycle-design.md`
状态：计划完成，等待编码授权

## 1. 实施目标

把桌面端集中库初始化从“保存路径后重启应用”改为“当前进程内受控激活并继续”，同时把已初始化后的入口改成只读的 Agent/Skill 重新发现与扫描流程。0.2.0 不实现集中库迁移。

完成后应满足：

- 首次初始化的新建库、已有库和备份恢复都不依赖应用重启。
- facade、部署后端及所有集中库业务在一次操作中使用同一个 `LibraryContext` 快照。
- 已初始化后访问 `/initialize` 不出现路径选择和恢复入口。
- 正常数据保护恢复继续作用于当前集中库；首次恢复使用独立命令，不污染普通恢复契约。
- 原 TC-US001-M02 改为“保存并继续”后在真实桌面复测。

## 2. 编码前约束

- 当前工作区已有未提交的重启临时修复、四份开发文档修改、`restart.test.ts` 和 `test-results/`。实施时先执行 `git status --short` 与 `git diff --check`，逐文件吸收或替换，不使用 reset/checkout 覆盖。
- `test-results/` 不纳入提交。
- 每个任务严格执行“失败测试 → 最小实现 → 相关回归 → 精确暂存”。
- 生成的 TypeScript 绑定只通过 Specta 生成测试更新，不手工修改重复契约。
- 每个提交只包含对应任务；四份当前开发文档留到行为稳定后统一更新。

## 3. 一致性修正：首次恢复延迟正式激活

设计目标同时要求“首次恢复先选目标”“恢复失败可改选目标”和“只允许一次正式激活”。因此实施采用以下精确语义：

1. 用户先选择目标目录，后端把它作为候选库进行创建或验证，但不发布为 `Active`。
2. 备份预检针对候选库执行。
3. 提交恢复成功后，再持久化目标路径并以不可失败的内存操作发布 `Active`。
4. 恢复或持久化失败时保持 `Pending`，允许重试或改选目录；候选目录内已安全写入的元数据或恢复内容作为可重试产物保留，不删除用户文件。

普通“新建集中库”和“使用已有集中库”仍由一次激活命令完成 `Pending -> Active`。

## 4. 任务拆分

### Task 1：拆分集中库“新建”与“打开已有”语义

修改文件：

- `crates/skillhub-storage/src/library/layout.rs`
- `crates/skillhub-storage/src/library/mod.rs`（如需导出新类型）
- `crates/skillhub-storage/tests/library_layout.rs`

先写失败测试：

- 新建模式允许不存在或空目录，并创建完整布局。
- 新建模式遇到包含未知用户文件、但不是集中库的目录时拒绝，不覆盖文件。
- 已有模式要求 `.skillhub/library.json` 已存在；普通目录不能被静默初始化成已有库。
- 已有模式接受受支持清单，拒绝损坏或未来版本清单。
- 两种模式都执行可写探测，探测文件必须清理；失败返回稳定、可操作错误。

最小实现：

- 为 `CentralLibrary` 增加职责明确的 `create` 与 `open_existing`（名称可按现有模块风格调整）。
- 保留 `initialize` 作为内部兼容入口或迁移到明确调用方，不能继续让“已有库”隐式创建清单。

验证命令：

```powershell
cargo test -p skillhub-storage --test library_layout
```

提交检查点：`Separate central library create and open modes`

### Task 2：建立共享 `LibraryRuntime` 生命周期单元

修改文件：

- 新增 `crates/skillhub-application/src/library_runtime.rs`
- `crates/skillhub-application/src/lib.rs`
- 新增 `crates/skillhub-application/tests/library_runtime.rs`，或在模块内添加仅测试可见用例

先写失败测试：

- `Pending` 读取集中库时返回稳定的 `library_not_ready` 原因。
- 有效上下文只能正式发布一次。
- `snapshot()` 返回 `Arc<LibraryContext>`；发布后根路径和 `VersionStore` 来自同一对象。
- 两个并发激活尝试被同一互斥边界串行化，不能出现两个成功发布。
- 已经 `Active` 后不能替换根路径。

最小实现：

- `LibraryContext { root: PathBuf, store: VersionStore }`。
- `LibraryRuntime` 内部持有 `RwLock<Option<Arc<LibraryContext>>>` 和激活互斥锁。
- 对外只提供候选上下文构造、不可变快照读取和一次性发布；不暴露裸写锁。

验证命令：

```powershell
cargo test -p skillhub-application library_runtime
```

提交检查点：`Add controlled library runtime lifecycle`

### Task 3：让 facade 构造器与部署后端共享运行时

修改文件：

- `crates/skillhub-application/src/lib.rs`
- `crates/skillhub-application/tests/facade.rs`
- 受构造器影响的 `crates/skillhub-application/tests/facade_*.rs`

先写失败测试：

- `LocalApplicationFacade::new` 构造 `Pending`。
- `new_with_library` 和 CLI 使用的 `open_with_library` 直接构造 `Active`。
- `LocalDeploymentBackend` 在激活后无需重建即可读取新上下文。
- `Pending` 时部署、移除和对账不会回退到其他目录，而是稳定失败。

最小实现：

- 删除 facade 的独立 `library`、`library_root` 字段，改为共享 `Arc<LibraryRuntime>`。
- `LocalDeploymentBackend` 持有同一个 runtime，不再复制 `Option<PathBuf>`。
- 合并 `new_with_today` 与 `new_with_library` 的重复装配代码，通过一个内部构造器注入 runtime，避免两套服务装配继续漂移。

验证命令：

```powershell
cargo test -p skillhub-application --test facade
cargo test -p skillhub-application --tests
```

提交检查点：`Share library runtime across facade services`

### Task 4：迁移全部集中库业务到单次上下文快照

修改文件：

- `crates/skillhub-application/src/lib.rs`
- 相关 `crates/skillhub-application/tests/facade_*.rs`

先写或收紧失败测试：

- 导入、版本、来源更新、健康检查、备份、恢复、导出、卸载和项目装配分别证明使用激活根。
- 同一业务调用只获取一次上下文；不能分别读取路径和 `VersionStore` 后拼成混合状态。
- `Pending` 的错误不被转换成泛化 `unknown`。

最小实现：

- 将所有 `self.library`、`self.library_root` 和后端 `library_root` 直接访问替换为操作起点的 `let library = self.library_runtime.snapshot()?`。
- 同一方法后续统一使用 `library.root` 与 `library.store`。
- 完成后用搜索保证旧字段访问为零。

验证命令：

```powershell
rg -n "self\.library\b|self\.library_root\b|LocalDeploymentBackend[\s\S]*library_root" crates/skillhub-application/src
cargo test -p skillhub-application --tests
```

提交检查点：`Use atomic library snapshots in application flows`

### Task 5：实现首次集中库激活命令与建议路径

修改文件：

- `crates/skillhub-core/src/api/command.rs`
- `crates/skillhub-application/src/lib.rs`
- `crates/skillhub-application/tests/facade.rs`
- `apps/desktop/src-tauri/src/lib.rs`

契约决策：

- 新增 `LibraryActivationMode::{Create, Existing}`。
- 用 `activate_library_root { path, mode }` 替代含义模糊的 `set_library_root`。
- 普通业务命令不提供任何已初始化后切换路径的入口。

先写失败测试：

- 首次新建和使用已有库分别激活正确路径，bootstrap 立即返回该路径。
- 激活成功后，同一 facade 的后续集中库操作直接使用新路径，无需重启。
- 空路径、未知目录、损坏清单、不可写路径失败时不持久化、不发布。
- 数据库持久化故障时保持 `Pending`；候选上下文不泄漏为活动状态。
- 完成初始化后返回 `library_root_locked`。
- 并发提交只有一个成功。

最小实现：

- 为桌面新用户增加“Pending + 建议默认路径”的构造方式；建议路径只用于 bootstrap 展示，不等于已激活。
- 桌面启动时：数据库已有根则 `Active`；没有根则 `Pending` 并提供平台默认建议路径。
- 激活顺序固定为：持有激活守卫 → 检查初始化状态 → 创建/打开候选库 → 构造上下文 → 保存路径 → 发布上下文。
- `complete_onboarding` 只接受当前活动上下文的路径。

验证命令：

```powershell
cargo test -p skillhub-application --test facade set_library_root
cargo test -p skillhub-application --test facade activation
cargo test -p skillhub-desktop
```

执行时按最终测试名替换过滤词，并确保至少完整运行一次两个测试包。

提交检查点：`Activate first-run library without restart`

### Task 6：增加首次恢复专用事务流程

修改文件：

- `crates/skillhub-core/src/api/command.rs`
- `crates/skillhub-application/src/lib.rs`
- `crates/skillhub-application/tests/facade.rs`
- `crates/skillhub-storage/tests/restore_migration.rs`（仅在需补底层故障证据时）

契约决策：

- 保留 `prepare_restore` / `commit_restore` 给数据保护页使用，目标始终是当前 `Active` 库。
- 新增 `prepare_initial_restore { backup_path, library_path }` 与 `commit_initial_restore { backup_path, library_path, decisions }`。

先写失败测试：

- 首次恢复预检使用候选目标，而不是平台默认路径或其他活动路径。
- 提交成功后才保存根并发布 `Active`。
- 恢复失败、冲突未决或数据库保存失败时仍为 `Pending`，可改选另一个目标。
- 已初始化实例拒绝首次恢复命令。
- 普通数据保护恢复仍只操作当前活动库。

最小实现：

- 复用 Task 1 的目录创建/打开规则和 Task 2 的激活守卫。
- 恢复成功后执行持久化与不可失败发布；不删除失败候选目录中的用户数据。

验证命令：

```powershell
cargo test -p skillhub-storage --test restore_migration
cargo test -p skillhub-application --test facade restore
```

提交检查点：`Add transactional first-run restore flow`

### Task 7：重新生成绑定并调整前端原生适配层

修改文件：

- `apps/desktop/src/api/bindings.ts`（生成）
- `apps/desktop/src/features/bootstrap/api.ts`
- `apps/desktop/src/features/bootstrap/api.test.ts`

先写失败测试：

- `activateLibraryRoot(path, mode)` 发送准确的类型化命令。
- 首次恢复发送目标路径和备份路径；普通恢复契约保持不变。
- onboarding operations 中不再存在 `restart`。

生成与实现：

```powershell
$env:SKILLHUB_WRITE_BINDINGS='1'
cargo test -p skillhub-desktop generate_bindings
Remove-Item Env:SKILLHUB_WRITE_BINDINGS
```

随后只修改前端 adapter 使用生成契约。

验证命令：

```powershell
cargo test -p skillhub-desktop generate_bindings
pnpm --dir apps/desktop test --run src/features/bootstrap/api.test.ts
```

提交检查点：`Expose library activation to desktop onboarding`

### Task 8：重构首次初始化三个分支

修改文件：

- `apps/desktop/src/features/onboarding/OnboardingWizard.tsx`
- `apps/desktop/src/features/onboarding/LibraryStep.tsx`
- `apps/desktop/src/features/onboarding/RestoreStep.tsx`
- 对应 `*.test.tsx`
- `apps/desktop/src/i18n/zh-CN/common.json`
- `apps/desktop/src/i18n/en-US/common.json`

先写失败测试：

- 新建库：默认建议路径或用户选定路径都必须调用 `activateLibraryRoot(..., "create")`，成功后直接进入兼容发现。
- 已有库：必须明确选择目录并调用 `"existing"` 模式；普通目录错误后仍可重选。
- 主按钮为“保存并继续”，不存在重启提示和重启调用。
- 目录选择取消不写入、不跳转。
- 首次恢复先选目标库，再选备份；失败后可改选目标并重试。
- 快速重复点击不会发起并发激活或恢复。

最小实现：

- 将“候选路径”和“已激活路径”分开建模。
- `RestoreStep` 接收并展示目标路径，改用首次恢复专用 operations。
- 保留现有冲突逐项决策、长耗时状态和取消语义。

验证命令：

```powershell
pnpm --dir apps/desktop test --run src/features/onboarding/LibraryStep.test.tsx src/features/onboarding/RestoreStep.test.tsx src/features/onboarding/OnboardingBranches.test.tsx src/features/onboarding/OnboardingWizard.test.tsx
pnpm --dir apps/desktop typecheck
```

提交检查点：`Continue onboarding after library activation`

### Task 9：实现已初始化后的“重新发现 Agent 与 Skill”模式

修改文件：

- `apps/desktop/src/app/router.tsx`
- 新增 `apps/desktop/src/features/onboarding/RescanWizard.tsx`
- 新增 `apps/desktop/src/features/onboarding/RescanWizard.test.tsx`
- `apps/desktop/src/features/settings/SettingsPage.tsx`
- `apps/desktop/src/features/settings/SettingsPage.test.tsx`
- `apps/desktop/src/i18n/zh-CN/common.json`
- `apps/desktop/src/i18n/en-US/common.json`
- 必要时调整 `apps/desktop/src/features/bootstrap/BootstrapGate.test.tsx`

先写失败测试：

- 路由先读取 bootstrap：未初始化渲染首次向导，已初始化渲染重新扫描。
- 重新扫描只读显示当前集中库路径，不显示三个初始化分支、目录选择器或恢复入口。
- 重新扫描只调用 Agent 发现和扫描，不调用激活或 `complete_onboarding`。
- 取消返回设置页，完成返回主界面；失败留在当前页且不清空结果。
- 设置入口文案改为“重新发现 Agent 与 Skill”。
- 直接访问 `/initialize` 也不能绕过模式判断修改集中库。

最小实现：

- 复用 `CompatibilityStep` 和 `ScanStep`，但不要继续给 `OnboardingWizard` 增加大量条件分支。
- 路由加载期间展示真实 loading/error 状态。

验证命令：

```powershell
pnpm --dir apps/desktop test --run src/features/onboarding/RescanWizard.test.tsx src/features/settings/SettingsPage.test.tsx src/app/router.test.tsx src/features/bootstrap/BootstrapGate.test.tsx
pnpm --dir apps/desktop typecheck
```

提交检查点：`Separate rescan from first-run onboarding`

### Task 10：删除初始化重启临时方案

修改文件：

- `apps/desktop/src-tauri/src/lib.rs`
- 删除 `apps/desktop/src/platform/restart.ts`
- 删除未提交的 `apps/desktop/src/platform/restart.test.ts`
- 清理所有引用和重启专用文案

先写/调整测试：

- 前端初始化测试明确断言激活后继续，不存在 restart seam。
- Tauri handler 不再注册 `restart_application`。
- 应用更新模块的独立 `app.restart()` 测试保持通过，证明没有误删更新重启。

最小实现：

- 用精确补丁移除当前工作区中的临时重启调度实现，不通过 Git 回退覆盖其他改动。
- `rg` 确认初始化路径无重启残留。

验证命令：

```powershell
rg -n "restart_application|desktopRestarter|restartPending|保存并重启|Save and restart" apps/desktop/src apps/desktop/src-tauri/src
cargo test -p skillhub-desktop
pnpm --dir apps/desktop test --run src/features/onboarding
```

允许保留的重启命中仅限应用更新模块及其测试。

提交检查点：`Remove onboarding restart workaround`

### Task 11：补端到端回归与错误文案

修改文件：

- `tests/e2e/onboarding.spec.ts`
- 必要时新增 DEV-only onboarding/rescan 预览夹具
- `apps/desktop/src/api/nativeErrors.ts`
- 双语 i18n 文件及审计测试

先写失败 E2E：

- 首次新建自定义库：保存后进入兼容发现，不出现重启文案。
- 已有库分支要求选择有效库。
- 已初始化 `/initialize`：只显示重新扫描界面和只读路径。
- 首次恢复展示目标路径并在失败后允许重试。
- `library_not_ready`、`library_root_locked`、无效已有库和不可写目录显示稳定错误码对应文案。

验证命令：

```powershell
pnpm test:e2e -- tests/e2e/onboarding.spec.ts
pnpm --dir apps/desktop test --run src/i18n/i18n.test.ts src/api/nativeErrors.test.ts
pnpm --dir apps/desktop check
```

提交检查点：`Cover library lifecycle user flows`

### Task 12：同步验收体系与执行全量验证

修改文件：

- `docs/用户故事.md`（仅当现有故事对重新扫描或首次恢复描述不足时）
- `scripts/generate_atomic_test_catalog.mjs` 的证据映射（如需）
- `docs/testing/原子测试目录-v0.2.0.md`（生成）
- `docs/development/开发状态-2026-09-10.md`
- `docs/development/自动化测试说明-2026-09-10.md`
- `docs/development/人工验收清单-2026-09-10.md`
- `docs/development/功能完成度与验收状态矩阵-2026-09-10.md`

文档调整：

- 删除“重新运行初始化向导可用于迁移”的误导，明确迁移在 0.2.0 不可用。
- 把 TC-US001-M02 改写为逐按钮的“保存并继续”真实桌面步骤，并保留原失败记录。
- 为“使用已有库”“首次恢复”“重新发现与扫描”增加清晰人工用例，每条下方逐条保留“验证结果：”。
- 将原有 restart 相关自动化证据替换为激活、路径一致性和重新扫描证据。
- 在真实桌面复测前，矩阵状态保持“自动化完成、Windows 待复测”。

全量验证命令：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
pnpm --dir apps/desktop check
pnpm --dir apps/desktop test --run
pnpm --dir apps/desktop build
pnpm test:e2e
cargo test -p skillhub-desktop generate_bindings
node scripts/generate_atomic_test_catalog.mjs
node scripts/verify_atomic_test_catalog.mjs
node scripts/i18n-cjk-audit.mjs
node scripts/verify_release_readiness.mjs
git diff --check
```

最后再执行 `node scripts/ci-local.mjs`，确认仓库定义的锁版本、依赖审计和生命周期检查也全部通过。

提交检查点：`Document library lifecycle verification`

## 5. 推荐执行顺序与停点

```text
Task 1-2  底层语义和生命周期
Task 3-4  facade 与所有业务消费者迁移
Task 5-6  首次激活和首次恢复命令
Task 7-9  绑定、首次向导、重新扫描界面
Task 10   删除重启临时方案
Task 11   E2E 与错误呈现
Task 12   全量回归和验收文档
```

不可提前的依赖：

- Task 5 必须在 Task 3-4 完成后实施，否则激活后仍会有组件持有旧路径。
- Task 8 必须等待 Task 5-7 的真实契约，不能先用前端假成功。
- Task 10 必须在“保存并继续”相关测试通过后删除临时方案，保证问题修复链条连续。
- Task 12 的真实桌面状态只能由人工验收填写，自动化通过不能代替 TC-US001-M02。

本计划在此停止。未获得明确编码授权前，不执行 Task 1，也不修改任何业务代码。
