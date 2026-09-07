# Plan 09 Task 24：备份创建与验证

## 状态

已完成。代码提交为 `a3fea85`；Windows 和 macOS 均完成只读验收。

## 已实现

- `CreateBackup` 从真实集中库读取当前 Skill 内容，复用敏感内容预检查，并要求每个敏感 Skill 有明确决定。
- 创建成功后立即运行完整清单校验，返回本地包路径和已验证的便携 manifest。
- `VerifyBackup` 校验用户提供的备份包及所有清单条目，只返回便携 manifest。
- 本地包路径仅存在于命令结果，不写入 `backup.json`，避免跨设备迁移泄露设备路径。
- Specta bindings 已重新生成并通过漂移测试。

## 验证

- Windows：本地 CI 10/10 通过；前端 60 个测试文件、336 个测试通过，安全审计 0 漏洞；专项测试 `backup_create`、`backup_created_result_has_path_and_portable_manifest`、`generate_bindings` 均通过。
- macOS：本地 CI 10/10 通过；前端 60 个测试文件、336 个测试通过，安全审计 0 漏洞；同上专项测试均通过。

## 边界与后续

本任务不恢复备份、不覆盖现有集中库、不执行滚动保留、不做标准导出或卸载；这些能力分别由后续 Task 接入真实 ApplicationFacade。临时构建可能删除 `apps/desktop/dist/.gitkeep`，验收收尾时已恢复该占位文件；用户本地 `.DS_Store` 等未跟踪文件不属于仓库变更。
