# Plan 06 Task 7：描述翻译与联网搜索辅助

## 状态

已完成并进入当前开发分支。

## 完成内容

- 新增描述翻译任务、固定 JSON Schema 和 `TranslationProvenance`，保留原始描述不变。
- 生成译文与用户修订使用独立记录；同一原文版本存在用户修订时，后续自动翻译会返回确认错误，不静默覆盖。
- 新增在线搜索查询辅助，只负责将用户输入转换为查询文本和可选来源筛选，不直接联网抓取；实际搜索仍由来源适配器和网络策略控制。
- 未配置 LLM 时，翻译和查询辅助返回 `llm.not_configured`，不影响本地 FTS5/BM25 搜索。
- 新增 `TranslateDescription`、`SaveUserTranslationRevision`、`GenerateOnlineSearchQuery` 命令及结果契约，并重新生成 TypeScript bindings。

## 测试与验证

- 翻译独立保存、用户修订保护和无 LLM 回退测试通过。
- 查询辅助输出与不联网边界测试通过。
- API contract 测试覆盖三个命令的稳定 wire shape。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` 通过。
- `cargo test --locked --workspace` 通过。
- `cargo test -p skillhub-desktop generate_bindings` 通过。

## 边界与后续

- 本 Task 不修改原始描述，不自动发布翻译，不替代用户确认。
- 查询辅助不执行联网请求；来源搜索仍需单独经过网络开关、来源适配器和用户操作。
- 下一步为 Plan 06 Task 8：实验性的使用证据分析，需继续保持“仅供参考、证据覆盖不完整时明确标注”的边界。
