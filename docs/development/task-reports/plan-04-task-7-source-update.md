# Plan 04 Task 7：来源重连与上游更新

## 状态

已完成并提交到 `main`：`9621022 feat: add safe source relink and update flow`。

## 完成内容

- 增加来源状态与更新决策模型：`SourceState`、`UpstreamCheckResult`、`UpdateDecision` 和 `AppliedSourceUpdate`。
- 增加 `SourceService` 与原生/存储层之间的 `SourceUpdateBackend` 边界。
- 来源重连只替换 Skill 的活动来源关系，不修改既有版本记录；SQLite 来源 ID 按来源类型和定位稳定计算并复用。
- 上游检查结果只表达观测到的状态；更新提交需要显式选择保留本地、采用上游或创建独立分支，取消与保留本地均不产生写入。
- 对存在本地修改的 Skill，未经明确处理不允许采用上游覆盖，并返回结构化冲突错误。
- 增加 `RelinkSource`、`CheckSourceUpdate`、`ApplySourceUpdate` 命令及对应结果契约，重新生成 TypeScript bindings。

## 验证

- `cargo test --locked --workspace`：通过。
- `cargo test -p skillhub-core --test source_update`：通过。
- `cargo test -p skillhub-storage --test source_repository`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。
- `git diff --check`：通过。

## 未包含范围

- 具体来源获取、版本捕获、上游合并和部署重协调仍由后续原生 Adapter/ApplicationFacade 接入。
- skills.sh 在线发现属于 Plan 04 Task 8。
