# Plan09 Task11：真实导入闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** 将桌面导入向导接入本地 ApplicationFacade，完成本地 Skill 候选发现、冲突分析、导入决策提交和取消的最小真实闭环。

**Architecture:** 复用现有 `SkillDetector`、`ImportService`、`CatalogService` 和 `VersionStore`，由 `LocalApplicationFacade` 统一协调查询与命令。候选发现只读取来源目录；提交阶段才写入集中库和 SQLite，并保留原始文件。前端通过专用 `NativeImportFacade` 将已冻结的 TypeScript 导入接口映射到 Rust 查询/命令契约。

**Tech Stack:** Rust、SQLite、Tauri 2、Specta TypeScript bindings、React、Vitest。

**Spec:** `docs/需求文档.md`、`docs/产品与交互设计.md`、`docs/技术架构设计.md`。

## Global Constraints

- Windows 和 macOS 是 V1 支持平台；Linux 不作为默认前提。
- 所有写操作必须可追踪、可重试、可恢复，并保留用户原始文件。
- 重复检测先使用确定性规则；LLM 语义分析不阻塞本 Task 的基础导入。
- Rust 到 TypeScript 的接口必须通过 Specta 生成并执行漂移校验。
- 不执行 shell、npx 或 Git 命令来获取来源；来源获取仍由现有适配器边界负责。
- 每个 Task 先写失败测试，再实现最小行为，完成后运行任务测试和完整本地 CI。

---

### Task 11.1：接通本地候选发现与导入分析查询

**Files:**
- Modify: `crates/skillhub-core/src/api/query.rs`、`crates/skillhub-core/src/api/mod.rs`
- Modify: `crates/skillhub-application/src/lib.rs`
- Test: `crates/skillhub-application/tests/facade.rs`
- Test: `crates/skillhub-core/tests/api_contract.rs`

**Interfaces:**
- Consumes: `AnalyzeImport { candidate, tree_hash }`、`Database::import_repository()`、`SkillDetector`。
- Produces: 真实 `AppQueryResult::ImportAnalysis`；候选目录只读，目录不存在或包含符号链接时返回结构化错误。

- [x] **Step 1: Write the failing tests**
  - 验证 `AnalyzeImport` 通过 SQLite 已有技能记录返回重复分析。
  - 验证非法来源目录返回 `InvalidInput`，不写入数据库。
  - 验证 API 序列化名称保持 `analyze_import`。

- [x] **Step 2: Run the focused Rust tests and verify they fail**

```text
cargo test -p skillhub-application --test facade analyze_import
cargo test -p skillhub-core --test api_contract
```

- [x] **Step 3: Implement the minimal query dispatch**
  - 在 `LocalApplicationFacade::query` 中调用 `ImportRepository::analyze`。
  - 保持候选内容和路径不落日志、不写入 SQLite。

- [x] **Step 4: Run focused tests and verify they pass**

```text
cargo test -p skillhub-application --test facade analyze_import
cargo test -p skillhub-core --test api_contract
```

- [x] **Step 5: Commit**

```text
git add crates/skillhub-core crates/skillhub-application
git commit -m "feat: expose native import analysis"
```

### Task 11.2：接通准备、提交和取消导入命令

**Files:**
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `crates/skillhub-storage/src/database/catalog_repository.rs`、`crates/skillhub-storage/src/database/source_repository.rs`
- Test: `crates/skillhub-application/tests/facade.rs`
- Test: `crates/skillhub-storage/tests/import_repository.rs`

**Interfaces:**
- Consumes: `PrepareImport`、`CommitImport`、`CancelImport`、`ImportService`、`CatalogService`、`VersionStore`。
- Produces: `PreparedImport`、`ImportSummary`；复制导入保留原目录，接管操作只有在复制和校验成功后才允许删除原目录。

- [x] **Step 1: Write failing tests**
  - 准备导入返回稳定的 `OperationId` 和冲突分析。
  - 提交 `CopyIntoLibrary` 后可通过 `ListSkills` 和 `GetSkill` 读取新 Skill。
  - 取消准备后再次提交返回 `ObjectNotFound`。
  - 提交失败时集中库和 SQLite 不留下半成品，原始目录仍存在。

- [x] **Step 2: Run focused tests and verify the expected unsupported-command failure**

```text
cargo test -p skillhub-application --test facade prepare_and_commit_import
```

- [x] **Step 3: Implement the minimal backend and command dispatch**
  - 为本地目录候选建立受控 `ImportBackend`，使用 `VersionStore::capture` 写入对象和版本清单。
  - 使用 `CatalogRepositorySqlite::insert` 持久化最小 Skill 元数据和当前版本。
  - 所有路径先经过现有安全校验；不删除用户原始目录。

- [x] **Step 4: Run focused tests and verify they pass**

```text
cargo test -p skillhub-application --test facade prepare_and_commit_import
cargo test -p skillhub-storage --test import_repository
```

- [x] **Step 5: Commit**

```text
git add crates/skillhub-application crates/skillhub-storage
git commit -m "feat: connect native import commands"
```

### Task 11.3：将桌面导入向导切换到原生门面

**Files:**
- Create: `apps/desktop/src/features/import/nativeApi.ts`
- Modify: `apps/desktop/src/features/import/ImportWizard.tsx`
- Modify: `apps/desktop/src/api/bindings.ts`（仅在 Specta 生成流程要求时更新）
- Test: `apps/desktop/src/features/import/nativeApi.test.ts`
- Test: `apps/desktop/src/features/import/ImportWizard.test.tsx`

**Interfaces:**
- Consumes: `query(AppQuery)`、`executeCommand(AppCommand)`、`ImportAnalysis`、`PreparedImport`、`ImportSummary`。
- Produces: `ImportFacade` 的 `parseSource`、`acquireCandidates`、`analyzeConflicts`、`commitImport`、`cancel` 实现；Unavailable 门面只保留测试和未连接运行时使用。

- [x] **Step 1: Write failing frontend tests**
  - 原生门面将候选目录查询映射为向导候选。
  - 冲突决策映射到 `CommitImport`，完成后回调导入结果。
  - 取消和结构化错误不会重复提交。

- [x] **Step 2: Run focused Vitest tests and verify they fail**

```text
pnpm --dir apps/desktop exec vitest run src/features/import/nativeApi.test.ts src/features/import/ImportWizard.test.tsx
```

- [x] **Step 3: Implement the native facade adapter and production wiring**
  - 保持向导现有阶段和可访问状态，不改变已确认的交互文案。
  - 对结构化错误只展示可恢复消息，不暴露本地绝对路径中的敏感片段。

- [x] **Step 4: Run frontend focused tests, typecheck, lint and build**

```text
pnpm --dir apps/desktop exec vitest run src/features/import/nativeApi.test.ts src/features/import/ImportWizard.test.tsx
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop build
```

- [x] **Step 5: Commit**

```text
git add apps/desktop/src/features/import
git commit -m "feat: connect import wizard to native facade"
```

### Task 11.4：跨平台联调与文档收口

**Files:**
- Modify: `docs/development/task-reports/plan-09-task-11-import-integration.md`
- Modify: `docs/development/当前开发状态.md`
- Test: `tests/integration/import_flow.rs`（如现有集成夹具适用）

- [x] **Step 1: Run Windows focused tests and complete local CI**
- [x] **Step 2: Send macOS validation instructions after the Windows commit is pushed**
- [x] **Step 3: Record both platform results, known limitations and recovery behavior**
- [x] **Step 4: Run `git diff --check` and commit the report**
