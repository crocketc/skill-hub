# Plan 05 Task 8：Agent 调用策略管理

## 状态

已完成并进入 `main`，代码提交为 `cf184af`。

## 本次完成

- 增加调用策略能力模型：可编辑、已识别但只读、不支持。
- 增加 `CallPolicyService` 的事实读取、变更预览、提交和恢复原值流程。
- 仅对能力明确为可编辑的目标允许修改；只读/不支持目标返回结构化 `call_policy.not_supported`，不会写入任何配置。
- 恢复操作交给适配器按原始值和所有权前置条件执行，核心层不假设 Agent 一定会加载或执行 Skill。
- 冻结调用策略命令、查询和 TypeScript bindings；为目录 Skill 调用策略补充独立的 Specta 类型名，避免与 Agent profile 中同名类型冲突。

## 验证

- `cargo test -p skillhub-core --test call_policy --test api_contract`
- `cargo test --locked --workspace`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo fmt --all -- --check`
- `cargo test -p skillhub-desktop generate_bindings`
- `git diff --check`

以上检查均通过。

## 后续边界

本 Task 提供 profile 声明驱动的核心服务和契约；具体各 Agent 文件格式的可写映射、原始配置保存和 ApplicationFacade/桌面设置页面接入仍需后续适配与联调。
