# Plan 09 Task 6：版本只读查询接入

## 目标

把集中库中的当前版本、版本清单和文件级差异以真实的 ApplicationFacade 查询提供给桌面端，同时保持版本内容不可变、来源信息不被猜测，暂不接入回滚等写操作。

## 已完成

- `GetSkill` 在连接集中库时返回真实的 `current_version` 指针；未连接集中库时保持 `null`，不会伪造版本。
- `ListVersions` 返回版本 ID、所属 Skill、当前版本标记、文件数以及相对上一条历史记录的新增/变更/删除计数。
- `DiffVersions` 返回两个版本之间的文件级新增、变更和删除路径。
- 版本清单确定性排序：当前版本优先，其余按版本 ID 倒序；变化计数按存储清单顺序计算，不将版本 ID 推断成时间。
- 版本差异比较拒绝跨 Skill 的两个版本，避免把不相关内容误判为更新。
- Specta bindings 已重新生成并通过漂移检查；前端详情原生摘要已读取当前版本字段，未知值显示为 `unknown`。
- 版本来源、创建时间、检查状态和部署影响没有可靠的当前数据来源，因此仍由详情页的后续真实业务门面负责；本 Task 不猜测这些字段。
- 回滚、设置当前版本、关系影响预览等写入或业务联动暂不接入，继续沿用明确的 unavailable 边界。

## 验证

- `cargo test -p skillhub-storage --test version_store`：14/14 通过。
- `cargo test -p skillhub-application --test facade`：6/6 通过。
- `cargo test -p skillhub-desktop --lib generate_bindings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`：通过。
- Windows 前端 TypeScript、ESLint、Vitest（55 个文件、315 项测试）和生产构建：通过。

## 后续

需要在 macOS 上对最新 `main` 重新运行本地 CI，并在后续 Task 中决定如何把真实版本查询映射到版本时间线，以及何时冻结回滚、部署关系和检查状态的完整原生契约。
