# Plan 09 Task 25：备份恢复、跨设备迁移与滚动保留

## 状态

已完成。代码提交为 `c2b61fc`；Windows 和 macOS 均完成验收。

## 已实现

- `PrepareRestore` 和 `CommitRestore` 接入真实 facade，恢复前验证包路径、目录类型和符号链接安全。
- 恢复计划与提交复用已有冲突决定和跨设备便携元数据规则。
- `RunRollingBackup` 创建并验证新包后应用滚动保留策略。

## 验证

- Windows/macOS 本地 CI 均为 10/10。
- ApplicationFacade facade 测试 42/42 通过，覆盖恢复成功、冲突决定、缺失路径、跨设备元数据和滚动保留。
- 相关 storage、API contract、bindings、格式和 clippy 检查通过。

## 边界

本任务不执行云端同步、不覆盖用户原文件，不改变备份包的便携 manifest 结构。CI 生成的 `dist/.gitkeep` 属于构建副作用，已在收尾时恢复。
