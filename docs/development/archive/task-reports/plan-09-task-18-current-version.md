# Plan09 Task18.1：切换当前版本闭环

## 状态

Windows 实现与 macOS 复核均已完成，提交为 `189e559`。

## 已完成内容

- `LocalApplicationFacade` 接通 `set_current_version` 命令。
- 目标版本必须存在且属于请求的 Skill；跨 Skill 版本会被拒绝，不改变原当前指针。
- 切换成功后同步 `.skillhub/skills` 元数据中的 `current_version`，读取详情和版本列表即可看到新指针。
- 集中库清单写入失败时回滚版本指针，避免出现部分提交。
- 桌面详情模块新增类型化 `setNativeCurrentVersion` 调用，并严格校验 `operation_summary` 返回类型。

## 验证

- Windows：Task18.1 facade 1/1、ApplicationFacade 全部 28/28、前端 native API 6/6、TypeScript 和 ESLint 通过。
- macOS：提交 `189e5598ba906587c73b27f1394fefe1426a25b1` 上本地 CI 10/10 通过；当前版本切换 Rust 1/1、前端 native API 6/6、TypeScript 通过。
- macOS 前端共 60 个测试文件、333 个测试通过，安全审计 0 漏洞，生产构建通过。
- 仅有既有重复依赖、撤回 crate 和前端分块体积警告。

## 边界与后续

- 本 Task 只切换已有不可变版本，不编辑 Markdown、不生成新版本，也不改变部署关系。
- CI 会删除 `apps/desktop/dist/.gitkeep` 作为构建副作用；macOS 验证按只读约定保留该状态并报告，未提交任何恢复。
- 下一步是 Task18.2：保存 Markdown 内容并生成新版本，需先冻结文件选择/权限授予契约。
