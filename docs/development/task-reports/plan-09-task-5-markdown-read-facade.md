# Plan 09 Task 5：集中库 Markdown 安全只读预览

状态：已完成代码实现，待 macOS 端完整 CI 复核

## 目标

把详情页 Markdown 工作区连接到集中库当前版本的只读内容，同时把文件路径、版本清单完整性和内容大小限制放在 Rust 存储层校验。本 Task 不实现编辑、写回、外部应用打开或 Agent/项目目录读取。

## 已完成

- 版本存储增加按不可变版本读取单个文件的能力：只接受清单中已记录的对象，校验对象身份，并拒绝路径穿越、缺失文件和超过调用方限制的内容。
- 增加 Markdown 文件列表查询，仅返回版本清单中的 `.md` 文件，并将 `SKILL.md` 标记为主文件。
- 增加 `ListMarkdownFiles`、`ReadMarkdownFile` 查询契约和 `MarkdownFiles`、`MarkdownFile` 结果；Markdown 内容限制为 1 MiB，必须是 UTF-8，结果固定为 `editable: false`。
- `LocalApplicationFacade` 支持连接集中库根目录；桌面入口使用 Windows/macOS 用户目录下的 `SkillHub` 集中库，不会因查询自动创建目录。
- 生产详情路由默认使用原生 Markdown 只读门面；预览路由仍使用隔离 fixture，所有写操作继续返回不可用状态。
- Specta bindings 已重新生成，未手工维护 TypeScript 契约副本。

## 测试与验证

- `cargo test -p skillhub-storage --test version_store`：13 项通过。
- `cargo test -p skillhub-application --test facade`：6 项通过。
- `cargo test --workspace --locked`：通过。
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`：通过。
- `cargo test -p skillhub-desktop --lib generate_bindings`：通过。
- Windows 前端检查：TypeScript、ESLint、Vitest（55 个文件、315 项测试）和生产构建均通过。此前失败是本机 pnpm 安装索引和虚拟依赖链接损坏；已停止挂起的安装进程并按锁文件重建本地生成依赖目录，未修改源码、lockfile 或依赖版本。完整跨平台 CI 仍待 macOS 端复核。

## 明确未包含

- 不提供 Markdown 编辑、保存、草稿、接管或覆盖源文件。
- 不读取 Agent/项目部署目录，也不推断 Agent 的运行时可执行性。
- 不在本 Task 内接入版本时间线、关系、检查结果和部署操作。
