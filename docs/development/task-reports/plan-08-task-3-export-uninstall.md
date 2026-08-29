# Plan 08 Task 3：标准导出与安全卸载准备

状态：已完成并进入 `main`。

## 本 Task 完成内容

- 标准导出支持选定 Skill/组合和当前/历史版本，输出中立的 `skills/` 目录与 `manifest.json`，不生成 ChatGPT、Claude 或其他平台专用上传包。
- 导出前识别可能的明文凭据，要求先处理、排除或明确纳入；导出不包含设备路径和 SkillHub 私有运行数据。
- 卸载准备生成影响预览，列出当前部署关系和可选动作：备份、标准导出、解除部署、保留独立副本、移除设备数据、保留集中库、清理凭据或取消。
- 通过 `PrepareStandardExport`、`CreateStandardExport`、`PrepareUninstall`、`ApplyUninstallDecision` 冻结上层契约，并生成 TypeScript bindings。

## 验证

- `cargo fmt --all -- --check`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo test --locked --workspace`：通过。
- `cargo test -p skillhub-storage --test export_uninstall`：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。
- `apps/desktop` ESLint、TypeScript：通过。
- `git diff --check`：通过。

## 明确边界

本 Task 只提供标准导出和卸载影响决策模型，不直接执行删除用户目录、解除部署、清理凭据或重建数据库。实际动作需在后续 ApplicationFacade 联调中使用既有可逆操作服务，并要求用户逐项确认。
