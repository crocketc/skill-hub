# Plan 06 Task 8：实验性使用证据分析

## 状态

已完成并进入当前开发分支；功能标记为实验性、仅供参考。

## 完成内容

- 新增 `UsageEvidence`、`EvidenceCoverage`、`GlobalSkillSuggestion` 和 `UsageEvidenceAnalysis` 模型。
- 分析支持用户配置观察窗口和调用阈值，按 Skill 聚合已有本地证据并给出“保留在全局/考虑移出”的建议。
- 结果明确包含证据来源和覆盖是否完整；覆盖不完整时不声称代表 Agent 的全部调用记录。
- 所有建议都标记为未自动执行，不会自动移出全局、解除部署或修改 Agent 配置。
- 新增 `EvidenceProvider` 抽象、显式本地证据适配器和存储侧证据仓库；不解析任意原始 Agent 对话，也不要求关联的 Runtime Hook 项目。
- 新增 `AnalyzeGlobalSkillEvidence` 查询契约并重新生成 TypeScript bindings。

## 测试与验证

- 不完整本地证据仍保留窗口、阈值、来源和实验标记测试通过。
- API contract 测试覆盖稳定查询 wire shape。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` 通过。
- `cargo test --locked --workspace` 通过。
- `cargo test -p skillhub-desktop generate_bindings` 通过。

## 边界与后续

- 当前只消费 SkillHub 已获得的明确本地记录；调用证据覆盖范围取决于可用集成，不能从 Agent 客户端目录或 UI 推断调用次数。
- Runtime Hook/各 Agent 运行时采集作为独立关联项目，后续可提高证据完整性，但不是本项目的强制依赖。
- Plan 06 已完成；下一步进入 Plan 07 真实 ApplicationFacade/原生文件选择器联调或 Plan 08 备份迁移主线，具体取决于整体集成安排。
