# Plan 09 Task 4：技能详情只读门面接入

状态：已完成（详情摘要、元数据和生产路由读取）

## 目标

复用本地 SQLite 的 Skill 目录事实，为生产技能详情页接入最小真实只读闭环，覆盖摘要和元数据；不在本 Task 内实现内容编辑、Markdown 文件读取或详情页写操作。

## 已完成

- 扩展 `GetSkill` 的 `SkillResult` 契约，返回原始描述、译文、用户备注、标签、许可证、生命周期和试用截止日期。
- SQLite 目录增加按 Skill ID 读取详情投影的方法，保留不存在对象的结构化错误边界。
- `LocalApplicationFacade` 将详情投影映射到 `skill` 查询结果，并保持数据库事实为唯一来源。
- 桌面端新增 `nativeSkillDetailFacade`，将详情投影映射为摘要和元数据；关系、版本、检查和写操作继续返回统一不可用状态。
- `/library/:skillId` 生产路由已使用真实只读门面；预览路由继续使用隔离 fixture。
- Specta 重新生成并通过 bindings 漂移检查。

## 测试与验证

- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-application --test facade`：5 项通过。
- `cargo test -p skillhub-desktop --lib generate_bindings`：通过。
- 前端新增 native detail facade 测试；Mac 端在提交后完成完整本地 CI 复核：10/10 通过，54 个测试文件、312 项测试通过，TypeScript、Lint、安全审计和生产构建均通过。
- `git diff --check`：通过。

## 明确未包含

- 不在本 Task 内读取或编辑集中库中的 `SKILL.md` 正文。
- 不在本 Task 内实现详情页的关系、需求、检查、版本、回滚、导入、部署和元数据保存。
- 不根据详情目录事实推断 Agent 登录、授权、信任或运行时可执行性。
