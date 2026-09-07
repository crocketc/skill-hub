# Plan 09 Task 3：技能库列表只读门面接入

状态：已完成（分页列表、文本筛选和前端最小真实读取）

## 目标

为桌面端 Skill 库页面接入本地 SQLite 的最小只读数据闭环：返回稳定排序的分页列表、文本筛选、标签集合和基础生命周期/试用信息，并由前端适配为现有技能表格行模型。

## 已完成

- 在核心查询契约中增加 `ListSkills`、`SkillListItem` 和 `SkillListPage`。
- SQLite 目录查询支持：
  - 显示名称、运行时名称、原始描述、译文描述和用户备注的字面文本匹配；
  - 1-based 分页，页大小限制在 1–100；
  - 按显示名称（不区分大小写）和 Skill ID 的稳定排序；
  - 从完整目录返回标签 facets，而不是只返回当前页标签；
  - 返回生命周期、试用截止日期、许可证和已保存的用户备注。
- `LocalApplicationFacade` 已转发 `list_skills` 查询，并保持未接入写操作的结构化错误边界。
- 桌面端新增 `nativeSkillLibraryFacade`，把真实查询结果映射到现有 `SkillTableRow`；查询结果不符合预期时显示统一的不可用状态。
- `/library` 生产路由已切换到该只读门面。
- 保留现有不可用边界：导入、部署、检查、抽屉偏好和写操作尚未接入真实 ApplicationFacade；当前查询暂不覆盖页面全部高级筛选字段。

## 测试与验证

- `cargo test -p skillhub-application --test facade`：5 项通过。
- `cargo test --workspace --locked`：全部通过。
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- 桌面端 Vitest：53 个文件、309 项测试全部通过。
- 桌面端 TypeScript：通过。
- 桌面端 ESLint：通过。
- `git diff --check`：待提交前执行。

## 明确未包含

- 不在本 Task 内实现导入、部署、解除部署、删除、检查或偏好保存。
- 不在本 Task 内接入完整页面筛选（生命周期、标签交集、Agent/项目关系、排序选项等）；后续任务需先冻结查询字段和结果契约。
- 不根据目录读取结果推断 Agent 是否已登录、授权、信任或能够实际执行 Skill。
