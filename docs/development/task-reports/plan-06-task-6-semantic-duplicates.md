# Plan 06 Task 6：语义重复分析与只读建议

## 状态

已完成并进入当前开发分支。

## 完成内容

- 新增 `DuplicateCandidate`、`DuplicateRelation` 和 `DuplicateAnalysis` 领域模型。
- 使用固定版本 JSON Schema 约束 LLM 输出，支持共同能力、独有能力、包含关系、证据和保留建议。
- `DuplicateService` 消费候选提供器结果，最多向 LLM 发送 8 条候选事实，避免把整个 Skill 库或正文无界发送出去。
- 新增 `AnalyzeSemanticDuplicates` 命令和 `duplicate_analysis` 结果契约，并重新生成 TypeScript bindings。
- LLM 任务明确标注 Skill 内容为事实数据；分析不自动归档、删除、覆盖或修改任何 Skill。
- 非法或不完整的结构化响应会返回 `LlmInvalidStructuredResponse`，不会产生可用分析结果。

## 测试与验证

- 语义重复服务：候选上限、包含关系和不自动执行建议测试通过。
- Prompt 构建：候选事实边界和只读约束测试通过。
- API contract：`analyze_semantic_duplicates` wire shape 测试通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` 通过。
- `cargo test --locked --workspace` 通过。
- `cargo test -p skillhub-desktop generate_bindings` 通过。

## 边界与后续

- 候选提供器通过接口接入现有 FTS5/BM25 搜索投影；本 Task 不自动改动库内 Skill，也不代替确定性重复检查。
- LLM 不可用时，确定性重复检查和本地搜索仍可独立工作。
- 下一步为 Plan 06 Task 7：描述翻译与联网搜索查询辅助。
