# Plan 09 Task 17：技能元数据写入闭环

## 状态

Windows 与 macOS 双平台复核已完成，提交为 `b22560b`。

## 已完成内容

- `LocalApplicationFacade` 接通重命名、备注/标签/作者/许可证、生命周期和试用日期四类命令。
- 所有更新先读取完整 Skill、通过领域校验，再以同步事务写入 SQLite；不存在的 Skill、空名称和非法元数据不会产生部分写入。
- 成功写入后同步集中库便携元数据，并返回结构化 `operation_summary`；不编辑 Markdown、不创建新版本、不改变部署关系。
- 桌面端新增类型化元数据原生门面，严格校验 `operation_summary` 返回类型。

## 验证

- Windows：整仓 `cargo test --locked --workspace` 通过；元数据 facade 2/2、桌面端原生门面 3/3、TypeScript 和 ESLint 通过。
- macOS：本地 CI 10/10 通过；元数据 facade 定向测试通过、原生门面 3/3、TypeScript 通过。
- 两端安全审计均为 0 漏洞；仅有既有重复依赖、撤回 crate 和前端大分块警告。

## 边界

- 当前操作只覆盖 Skill 元数据，不包含 Markdown 编辑、版本切换、删除、导入或部署。
- workspace 根目录没有 Vitest/TypeScript 二进制，专项验证需使用 `apps/desktop/node_modules/.bin` 下的实际路径。
