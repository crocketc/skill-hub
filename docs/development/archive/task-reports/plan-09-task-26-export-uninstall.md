# Plan 09 Task 26：标准导出与卸载准备

## 状态

已完成。代码提交为 `39cfc31`；Windows 和 macOS 均完成验收。

## 已实现

- `PrepareStandardExport` 和 `CreateStandardExport` 从受控版本目录构建标准导出，敏感内容需要显式决定。
- `PrepareUninstall` 返回活动部署影响，`ApplyUninstallDecision` 支持取消、解除管理或移除受管部署。
- 卸载流程复用所有权校验，不删除集中库 Skill 或用户原文件。

## 验证

- Windows/macOS 本地 CI 均为 10/10。
- facade 测试覆盖导出准备/创建、敏感决定和卸载决定；storage 导出/卸载专项测试通过。
- API contract、bindings、格式、clippy 和 `git diff --check` 通过。

## 边界

备份、清理设备数据、清除凭据等卸载扩展动作仍按当前安全边界返回未支持，不会被隐式执行。
