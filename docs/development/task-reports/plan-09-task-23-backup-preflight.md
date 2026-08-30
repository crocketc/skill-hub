# Plan 09 Task 23：备份预检查门面

## 状态

- 已完成并合并到 `main`。
- 代码提交：`38455a6`；格式修复：`bdbc7cb`。
- 验收收口：Windows/macOS 均已通过。

## 完成内容

- 真实 `LocalApplicationFacade` 支持 `PrepareBackup` 的 `Full` 范围。
- 从集中库便携清单、SQLite 目录和当前不可变版本读取备份预检查所需内容。
- 只读取当前版本的 `SKILL.md`，不执行 Skill、脚本或 Markdown 代码。
- 复用既有 `BackupService::prepare` 识别潜在明文凭据，并返回结构化敏感内容条目。
- 没有当前版本或内容不是 UTF-8 时返回结构化错误。
- `SelectedSkills` 暂不接受：现有命令没有携带选定 Skill ID，避免产生不完整的备份范围。
- 预检查不创建备份目录、不写入数据库、不修改便携清单。

## 验证

### Windows

- 完整本地 CI：10/10 通过。
- 备份预检查 facade：2/2 通过。
- 备份存储测试：4/4 通过。
- API 契约测试：1/1 通过。
- 前端 60 个测试文件、336 个测试通过；安全审计 0 个漏洞；生产构建通过。
- npm audit 使用官方源复核后恢复原镜像 `https://registry.npmmirror.com`。

### macOS

- `main` 已同步到 `bdbc7cb`。
- 完整本地 CI：10/10 通过。
- 备份预检查专项：2/2 通过。
- 前端 60 个测试文件、336 个测试通过；安全审计 0 个漏洞；生产构建通过。
- 未修改源码、依赖或文档；仅有 CI 删除的 `apps/desktop/dist/.gitkeep` 和本地 `.DS_Store` 未跟踪文件。

## 已知边界

- 本 Task 只提供备份前置分析，不创建实际备份包。
- 备份创建、路径验证、恢复、滚动保留、标准导出和卸载准备仍需独立的 ApplicationFacade 与桌面交互任务。
- `SelectedSkills` 需要后续扩展命令输入以携带明确 Skill ID。
