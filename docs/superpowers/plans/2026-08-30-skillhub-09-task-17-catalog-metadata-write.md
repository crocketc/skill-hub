# Plan09 Task17：技能元数据写入闭环

**Goal:** 将详情页已存在的重命名、备注/标签、生命周期和试用状态操作接入本地 ApplicationFacade，保持 SQLite 与集中库便携元数据的一致性。

## 边界

- 只修改 Skill 元数据，不编辑 Markdown 正文、不创建新版本、不改变部署关系。
- 所有写入按 Skill ID 定位，拒绝不存在的 Skill 和非法名称/日期/元数据。
- 写入成功后返回结构化 `OperationSummary`；失败不留下半更新状态。
- 不执行 Skill 内容中的命令、脚本、代码块或 MCP。

## Task 17.1：Rust facade 与持久化

- [x] 先写失败测试：四类命令成功更新查询结果；不存在 ID、空名称和非法试用元数据失败且不产生部分写入。
- [x] 增加同步元数据更新能力，复用 Skill 领域校验，并同步集中库便携元数据。
- [x] 在 `LocalApplicationFacade::execute` 中接入四类命令，保留结构化结果。
- [x] 运行 facade 与存储定向测试及整仓 Rust 测试。

## Task 17.2：桌面端原生门面

- [x] 增加类型化 metadata mutation API，严格校验 `operation_summary`。
- [x] 测试重命名、元数据、生命周期和试用命令映射，以及异常结果拒绝。

## Task 17.3：双平台收口

- [x] 更新 Task 报告、当前开发状态和本计划。
- [x] Windows CI 通过后提交推送，由 macOS 在同一提交上只读复核。
