# Plan09 Task18：版本写入与当前版本切换

## 目标

把详情页的版本操作接入本地 ApplicationFacade，先支持把一个 Skill 的当前版本指针切换到同一 Skill 已存在的版本，再支持保存 Markdown 内容生成不可变新版本。

## 任务拆分

### Task18.1 切换当前版本（已完成）

- 先写 facade 回归测试，覆盖成功切换、跨 Skill 版本拒绝和失败后当前指针保持不变。
- 在 Rust ApplicationFacade 接通 `set_current_version` 命令。
- 校验目标版本归属，更新版本存储的当前指针，并同步可迁移清单中的当前版本字段。
- 接通详情页 TypeScript native API，并保留统一的结构化操作结果。

验收：对应 facade 测试、前端 native API 测试、TypeScript、Lint 和双平台本地 CI 通过。Windows 提交为 `189e559`，macOS 在同一提交上复核通过。

### Task18.2 保存 Skill 内容目录生成新版本（编辑器适配待后续）

- 接通现有 `save_skill_content` 目录源契约，先完成后端捕获和版本指针更新。
- 新版本必须通过 `SKILL.md` 基础校验，版本对象保持不可变，成功后切换当前版本。
- 覆盖取消、非法内容、写入失败和回滚测试。
- Markdown 编辑器传递内存草稿所需的临时文件/权限授予契约仍未冻结，暂不把生产 Markdown 门面标记为可编辑。

### Task18.3 双平台验证与文档（Task18.1 已完成）

- Windows 与 macOS 均运行本地 CI 和 Task18 专项测试。
- Task18.1 的双平台结果已汇总到开发状态和 Task 报告；Task18.2 完成后需再补充版本写入验收。
