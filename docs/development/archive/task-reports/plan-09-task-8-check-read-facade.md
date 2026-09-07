# Plan 09 Task 8：检查结果只读查询接入

## 目标

把已持久化的基础检查、LLM 检查和发现项投影到共享 `ApplicationFacade`，让详情页可以读取确定性的检查状态，同时保持两种检查彼此独立。

## 已完成

- `GetBasicCheckResult` 返回指定 Skill/版本的基础检查状态、运行 ID、规则集、结束时间、发现项数量和可处理数量。
- `GetLlmSafetyCheckResult` 使用相同投影规则读取 LLM 检查，但返回独立的 LLM 结果类型，不覆盖基础检查结果。
- `ListFindings` 只读取指定 Skill、版本和检查类型的当前运行发现项，并映射为不含本地化句子的结构化结果。
- 没有当前运行时返回 `not_checked` 和空发现项；不会把未配置 LLM、没有运行记录或旧版本记录误报为失败。
- 查询使用仓库已有的 generation/时间确定性选择规则，发现项处置状态由持久化记录决定。
- 仅接入只读查询；执行检查、重新检查、处置发现项和部署门禁写操作仍保持原有边界。

## 验证

- `cargo test -p skillhub-application --test facade`：8/8 通过。
- `cargo test -p skillhub-storage --test check_repository`：5/5 通过。
- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`：通过。
- macOS `./scripts/ci-local.sh`：通过 10/10；Rust 与前端全量检查、55 个测试文件/315 项测试、安全审计和生产构建均通过。Markdown 工作区与详情页测试通过，未出现新增失败。

## 后续

后续 Task 再接入检查结果到详情页、发现项处置命令、部署门禁和检查运行编排。
