# Plan 03 Task 4：自定义 Agent 与目录覆盖

状态：已完成

## 结果

- 增加自定义 Agent、opaque file-picker grant 和 resolver 端口。
- API 命令只传 grant ID；实际目录由受控 resolver 解析，不信任前端裸路径。
- 强制 profile 的全部 global path candidates 绑定到同一个 resolver 目录。
- Windows 使用不区分大小写匹配；macOS 保留大小写，避免授权绕过。
- 增加创建、更新、删除自定义 Agent，以及设置/重置 Profile Override 的契约。
- 允许内置 profile 或已存在自定义 Agent 的 override，拒绝未知目标。
- 使用 SQLite 事务持久化，覆盖第二次写失败回滚。
- 删除和重置只修改 SkillHub 元数据，不删除或修改用户目录。
- 恶意 JSON、命令字段、真实临时目录保护和 TypeScript bindings 均有测试。

## 关键提交

- 初始实现：`712b0b6`
- 修复提交：`8075620`、`7a8b35c`
- 合并到 main：`3f2efd1`

## 验证

- custom Agent 和 repository tests
- workspace tests（包含 generate_bindings）
- fmt、Clippy 和 `git diff --check`

## 未完成事项

- ApplicationFacade 对这些新命令/查询的实际执行接线尚未完成。
- Windows/macOS 原生文件选择器尚未接入；当前只冻结 resolver 接口和安全边界。
