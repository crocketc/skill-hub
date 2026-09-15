# Task 1 实施报告：建立 Skill 关系领域模型与兼容性判定

## 状态

DONE_WITH_CONCERNS

基础实现提交：`76b8c33`（`feat: add normalized skill relationship domain`），关系契约修复提交：`295a4b1`（`fix: finalize relationship domain contracts`）。本次最终复审补丁使用提交消息 `fix: disambiguate legacy provenance compatibility id`。

## 需求映射

- 新建 `relationship` 领域模块，提供 `DirectoryRole`、`DirectoryRecognition`、`RelationshipType`、`FileRepresentation`、`OwnershipState`、`ConflictClassification`、`GovernanceTaskKind`。
- 提供 `DirectoryNodeFact`、`AgentDirectoryCapabilityFact`、`SourceRelationFact`、`DeploymentRelationFact`、`ConflictCaseFact`、`GovernanceTaskFact`。
- `RelationshipType` 使用稳定序列化名称：`import_copy`、`shared_directory_read`、`shared_directory_reference`、`managed_copy`、`managed_link`、`observed_copy`、`observed_link`、`unknown`。
- `FileRepresentation` 使用 `directory`、`symbolic_link`、`directory_junction`、`unknown`；用户标签将管理/观察复制统一为“复制部署”，链接统一为“链接部署”，技术表示另提供“符号链接/目录联结”。
- `classify_conflict_evidence` 只读取传入证据：指纹一致为 `same_skill_version`；在指纹不同、名称一致且身份证据充分时为 `distinct_skill`；证据不足为 `uncertain`。
- `ImportProvenance::to_source_relation_fact` 和 `ObservedDeployment::to_deployment_relation_fact` 提供纯兼容视图。旧观察记录缺少文件表示/链接目标时保留为 `unknown`，不猜测复制或链接。
- `stable_provenance_id` 的兼容哈希纳入 `imported_at`：同一 Skill、路径、指纹的不同导入事件不会复用同一兼容 `provenance_id`；同一导入事实重复转换仍保持稳定。该 ID 只属于 legacy compatibility view，明确不是未来 0014 新关系表的导入事件主键，未修改存储 schema。
- 保留最终关系契约修复：不同指纹不返回 `SameSkillVersion`；`DeploymentRelationFact.link_target_directory_id`、`ConflictKind::Unknown`、`Option<SkillId>`、`Copy`、typed `origin`/`match_state` 均保持。
- 未修改数据库、迁移、IPC、应用服务、前端，也未加入文件系统 I/O、网络或 LLM 调用；未改变现有存证和观察结构字段语义。

## 修改文件

- `crates/skillhub-core/src/relationship/mod.rs`
- `crates/skillhub-core/src/lib.rs`
- `crates/skillhub-core/src/import/provenance.rs`
- `crates/skillhub-core/src/deployment/observed.rs`
- `crates/skillhub-core/src/deployment/mod.rs`

本次最终复审实际变更集中在 `crates/skillhub-core/src/import/provenance.rs` 的兼容哈希、注释和回归测试；未修改存储、IPC、UI、计划或设计文件。

## TDD 与测试结果

### Red

- 原要求命令 `cargo test -p skillhub-core relationship observed` 在当前 Cargo CLI 中失败：`unexpected argument 'observed' found`。
- 使用等价单过滤器 `cargo test -p skillhub-core relationship` 验证新测试先因领域类型、纯函数和兼容方法尚未实现而编译失败。
- 最终复审回归测试先改为断言不同 `imported_at` 必须产生不同 ID；单独运行 `cargo test -p skillhub-core normalized_source_relation_id_is_stable_per_import_event` 时按预期失败，证明旧哈希遗漏导入时间。

### Green / 回归

- `cargo test -p skillhub-core relationship`：通过，18 个关系测试。
- `cargo test -p skillhub-core observed`：通过，10 个观察相关测试。
- `cargo test -p skillhub-core`：通过，61 个核心单元测试、全部现有集成测试目标和文档测试均通过。
- `cargo fmt --all -- --check`：通过。
- `git diff --check`：通过；提交前暂存差异检查也通过。

测试覆盖了稳定序列化名称、共享目录识别状态、复制/链接展示标签、技术文件表示、三类冲突分类、事实结构序列化，以及旧导入存证和旧观察部署的兼容转换。

## 自检与未解决风险

- `cargo test` 期间 Cargo 多次报告无法清理旧的 `target/debug/incremental` 目录（Windows `os error 5`，拒绝访问）；构建和测试均成功，未触碰构建产物。
- 当前环境没有安装 `cargo-llvm-cov`（`cargo llvm-cov --version` 返回 `no such command`），因此本任务未生成覆盖率报告，不能据此宣称达到 80% 覆盖率阈值。
- 关系领域模型只提供事实和纯分类；数据库持久化、关系扫描、治理操作、回退和前端接入仍由后续 Task 实现。
