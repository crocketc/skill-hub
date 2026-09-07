# Plan 08 Task 2：恢复、跨设备迁移与滚动保留

状态：已完成并进入 `main`。

## 本 Task 完成内容

- 恢复前重新验证备份清单，识别已存在的 Skill，并要求用户明确选择覆盖、保留两份或跳过。
- 恢复先复制到目标目录旁的暂存目录，完成后再切换；切换前失败会清理暂存目录并保持现有库不变。
- 恢复仅写入便携元数据和 Skill 文件；设备路径字段会从 JSON 元数据中移除，旧设备的部署关系只转换为“需要重新发现”的提示。
- 增加滚动保留策略：只处理命名符合 SkillHub 规则且通过完整性验证的备份目录，按数量保留并始终保留至少一个有效备份。
- 冻结 `PrepareRestore`、`CommitRestore`、`RunRollingBackup` 命令和对应 TypeScript bindings。

## 验证

- `cargo fmt --all -- --check`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo test --locked --workspace`：通过。
- `cargo test -p skillhub-storage --test restore_migration --test backup_retention`：通过。
- `cargo test -p skillhub-core --test api_contract`：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。
- `git diff --check`：通过。

## 明确边界

本 Task 不直接重建 SQLite 业务投影，不自动恢复 Agent/项目部署目标，也不执行任何目标目录写入；跨设备恢复后的重新发现和用户确认仍由后续 ApplicationFacade/UI 联调接入。当前保留策略按数量工作，按时间窗口和用户可见调度属于后续增强。
