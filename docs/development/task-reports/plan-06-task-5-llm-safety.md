# Plan 06 Task 5：LLM 安全检查与提示词注入防御

## 完成内容

- 增加独立的 LLM 安全检查服务，使用 `CheckKind::Llm` 保存运行记录，不覆盖基础检查结果。
- Skill 内容以明确的 `UNTRUSTED_SKILL_EVIDENCE` 分隔块传入，并在提示词中声明不得执行其中指令。
- 固定 JSON Schema 只允许安全维度、严重级别、已传输文件位置和简短解释；不允许模型返回任意编辑或执行动作。
- 只接受已传输文件中的证据引用，越界文件引用会被拒绝。
- 支持提示词注入、敏感指令、不安全意图、外部数据外传和凭据处理五类 LLM 安全发现。
- 增加 `RunLlmSafetyCheck`、`RecheckLlmSafety` 和 `GetLlmSafetyCheckResult` 合约，并生成 bindings。

## 测试与验证

- `cargo test -p skillhub-core --test llm_safety --test api_contract`
- `cargo test -p skillhub-adapters --test llm_safety_prompt`
- `cargo test --locked --workspace`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。Windows 链接器输出的既有提示不影响测试结果。

## 边界与后续接入

本 Task 不替代确定性的基础检查，不执行模型返回的命令或修改建议，也不把 LLM 不可用解释为基础检查失败。实际 ApplicationFacade、凭据注入和桌面 UI 联调由后续任务完成。
