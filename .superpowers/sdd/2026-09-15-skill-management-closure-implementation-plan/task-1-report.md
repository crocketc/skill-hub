# Task 1 实施报告：建立 Skill 关系领域模型与兼容性判定

## 状态

DONE_WITH_CONCERNS

实现提交：`76b8c33`（`feat: add normalized skill relationship domain`）。

## 需求映射

- 新建 `relationship` 领域模块，提供 `DirectoryRole`、`DirectoryRecognition`、`RelationshipType`、`FileRepresentation`、`OwnershipState`、`ConflictClassification`、`GovernanceTaskKind`。
- 提供 `DirectoryNodeFact`、`AgentDirectoryCapabilityFact`、`SourceRelationFact`、`DeploymentRelationFact`、`ConflictCaseFact`、`GovernanceTaskFact`。
- `RelationshipType` 使用稳定序列化名称：`import_copy`、`shared_directory_read`、`shared_directory_reference`、`managed_copy`、`managed_link`、`observed_copy`、`observed_link`、`unknown`。
- `FileRepresentation` 使用 `directory`、`symbolic_link`、`directory_junction`、`unknown`；用户标签将管理/观察复制统一为“复制部署”，链接统一为“链接部署”，技术表示另提供“符号链接/目录联结”。
- `classify_conflict_evidence` 只读取传入证据：指纹一致为 `same_skill_version`；在指纹不同、名称一致且身份证据充分时为 `distinct_skill`；证据不足为 `uncertain`。
- `ImportProvenance::to_source_relation_fact` 和 `ObservedDeployment::to_deployment_relation_fact` 提供纯兼容视图。旧观察记录缺少文件表示/链接目标时保留为 `unknown`，不猜测复制或链接。
- 未修改数据库、迁移、IPC、应用服务、前端，也未加入文件系统 I/O、网络或 LLM 调用；未改变现有存证和观察结构字段语义。

## 修改文件

- `crates/skillhub-core/src/relationship/mod.rs`
- `crates/skillhub-core/src/lib.rs`
- `crates/skillhub-core/src/import/provenance.rs`
- `crates/skillhub-core/src/deployment/observed.rs`
- `crates/skillhub-core/src/deployment/mod.rs`

## TDD 与测试结果

### Red

- 原要求命令 `cargo test -p skillhub-core relationship observed` 在当前 Cargo CLI 中失败：`unexpected argument 'observed' found`。
- 使用等价单过滤器 `cargo test -p skillhub-core relationship` 验证新测试先因领域类型、纯函数和兼容方法尚未实现而编译失败。

### Green / 回归

- `cargo test -p skillhub-core relationship`：通过，11 个关系测试。
- `cargo test -p skillhub-core observed`：通过，9 个观察相关测试。
- `cargo test -p skillhub-core`：通过，52 个核心单元测试、全部现有集成测试目标和文档测试均通过。
- `cargo fmt --all -- --check`：通过。
- `git diff --check`：通过；提交前暂存差异检查也通过。

测试覆盖了稳定序列化名称、共享目录识别状态、复制/链接展示标签、技术文件表示、三类冲突分类、事实结构序列化，以及旧导入存证和旧观察部署的兼容转换。

## 自检与未解决风险

- `cargo test` 期间 Cargo 多次报告无法清理旧的 `target/debug/incremental` 目录（Windows `os error 5`，拒绝访问）；构建和测试均成功，未触碰构建产物。
- 当前环境没有安装 `cargo-llvm-cov`（`cargo llvm-cov --version` 返回 `no such command`），因此本任务未生成覆盖率报告，不能据此宣称达到 80% 覆盖率阈值。
- 关系领域模型只提供事实和纯分类；数据库持久化、关系扫描、治理操作、回退和前端接入仍由后续 Task 实现。
