# Plan 09 Task 1：本地 ApplicationFacade 启动查询闭环

状态：已完成（最小只读闭环）

## 目标

为桌面端提供共享的本地 `ApplicationFacade` 实现，先打通 SQLite 数据库到应用查询契约的最小闭环，消除生产启动默认使用 `UnconfiguredFacade` 的问题。

## 已完成

- 新增 `crates/skillhub-application` 共享应用层 crate，供桌面端及后续 CLI 接入。
- `LocalApplicationFacade` 使用受互斥保护的 SQLite 数据库，保证门面满足 `Send + Sync` 边界。
- 接通 `GetBootstrapSnapshot`：返回技能、项目、Agent、部署、待处理事项和恢复状态等数据库投影。
- 接通 `ListPendingItems`：与启动快照共用同一日期边界，保证试用到期判断一致。
- 桌面端启动时打开平台用户应用数据目录中的 `SkillHub/skillhub.sqlite`：Windows 使用 `%APPDATA%/SkillHub`，macOS 使用 `~/Library/Application Support/SkillHub`。
- 未接入的命令/查询继续返回结构化错误，不执行隐式写入或伪造成功结果。
- 补齐 `ListPendingItems` 的核心 API 导出，保持查询契约可被共享应用层使用。

## 测试与验证

- `cargo test -p skillhub-application --test facade`：3 项通过。
- `cargo test -p skillhub-desktop --lib`：3 项通过。
- `cargo test --workspace --locked`：整仓通过。
- `cargo clippy -p skillhub-application -p skillhub-desktop --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `git diff --check`：通过。

## 明确未包含

- Skill 列表/搜索的统一应用查询尚未冻结，当前不把前端 Mock Facade 直接映射为临时 IPC 接口。
- 导入、发现、部署、检查、备份等写操作仍待后续按独立 Task 接入；本 Task 不执行文件系统副作用。
- macOS Universal DMG 的 x86_64 工具链缺口仍由设备环境处理，不属于本 Task。
