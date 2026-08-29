# Plan 08 Task 1：可验证便携备份包

状态：已完成并进入 `main`。

## 本 Task 完成内容

- 建立目录式便携备份包格式，包含便携元数据、Skill 内容和版本化 `backup.json` 清单。
- 备份清单为每个文件保存 SHA-256；验证会拒绝篡改内容、绝对路径和路径穿越。
- 备份准备阶段确定性识别 Skill 中可能的明文凭据，并要求用户为每个命中的 Skill 选择：先处理、排除 Skill，或带敏感标记纳入。
- 设备路径作为输入边界被明确排除，不写入备份包。
- 冻结 `PrepareBackup`、`CreateBackup`、`VerifyBackup` 命令和对应 TypeScript bindings。

## 主要文件

- `crates/skillhub-core/src/backup/`：备份格式、范围、敏感内容决策和清单模型。
- `crates/skillhub-storage/src/backup/`：备份创建、敏感内容预检和完整性验证。
- `crates/skillhub-storage/tests/backup.rs`：完整包、篡改、敏感决策和路径安全测试。
- `crates/skillhub-core/src/api/command.rs`、`apps/desktop/src/api/bindings.ts`：应用命令契约与生成 bindings。

## 验证

- `cargo test --locked --workspace`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-storage --test backup`：通过。
- `cargo test -p skillhub-core --test api_contract`：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。
- `git diff --check`：通过。

## 明确边界

本 Task 只提供可验证的便携备份包基础，不包含恢复、跨设备迁移、备份保留清理、CLI、发布或卸载流程。当前实现使用目录式包作为内部基础，最终用户可见的导出介质和恢复交互在后续 Task 冻结。

备份元数据由上层提供时必须遵守既定的便携元数据边界；本 Task 不把凭据或设备路径自动写入包，也不以 LLM 结果替代确定性敏感内容门禁。
