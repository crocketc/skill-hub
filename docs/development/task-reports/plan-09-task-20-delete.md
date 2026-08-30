# Plan 09 Task 20：集中库 Skill 删除闭环

## 状态

- 已完成并合并到 `main`。
- 提交：`42de782`。
- Windows 与 macOS 本地 CI 均为 10/10 通过。

## 完成内容

- ApplicationFacade 接通 `PrepareDeleteSkill` 与 `CommitDeleteSkill`。
- 删除前生成明确的 `RemovalImpact`，列出 Skill、活动部署关系和依赖信息；没有关系时也返回可确认的空影响结果。
- 提交阶段复用准备快照，要求每条活动部署关系都有明确决定；缺少决定、取消、快照不存在或关系不一致时拒绝执行。
- 删除前拒绝 `DetachManagement` 决定，避免先解除关系再因集中库删除失败产生部分状态。需要保留目标内容时使用保留共享部署/仅移除关系的决定。
- 集中库删除会移除目录清单、便携 Skill 元数据、当前版本指针和该 Skill 的不可变版本对象。
- 删除不会级联修改 Agent/项目中的用户原文件；活动受管部署未先处理时会被拒绝。
- 便携元数据或目录清理失败时恢复目录清单和便携元数据，并返回结构化错误。

## 测试与验收

Windows：

- 完整本地 CI：10/10 通过。
- `cargo test -p skillhub-core --test undeploy_delete`：4/4 通过。
- `prepare_delete_skill_command_returns_explicit_impact`：1/1 通过。
- `delete_skill_commit_removes_catalog_portable_metadata_and_versions`：1/1 通过。
- `cargo test -p skillhub-storage --test version_store`：14/14 通过。

macOS：

- 提交 `42de782` 已同步到 `main`。
- 完整本地 CI：10/10 通过，前端 60 个测试文件、334 个测试通过，安全审计 0 个漏洞，生产构建通过。
- `undeploy_delete`：4/4 通过。
- `prepare_delete_skill_command_returns_explicit_impact`：1/1 通过。
- `delete_skill_commit_removes_catalog_portable_metadata_and_versions`：1/1 通过。
- `version_store`：14/14 通过。

两端均报告了构建过程可能删除 `apps/desktop/dist/.gitkeep` 的既有副作用；该文件属于仓库占位文件，Windows 端已恢复后提交，macOS 端按只读验收要求未修改。`.DS_Store` 等本地未跟踪文件未纳入仓库。

## 已知边界

- 当前删除闭环仍是本地 ApplicationFacade 能力，桌面端删除页面的真实原生门面和完整 UI 联调留待后续任务。
- 删除操作不自动处理未知外部引用、不删除用户原文件，也不级联删除其他 Skill；依赖和引用处理需要在影响结果中由用户明确选择。
- 删除版本对象前没有跨设备同步；备份、恢复和迁移仍按 Plan 08 的独立任务推进。
