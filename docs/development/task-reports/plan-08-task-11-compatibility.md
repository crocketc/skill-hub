# Plan 08 Task 11：兼容性与发布验收记录

状态：验收中（确定性 profile 契约和记录框架已完成，真实客户端/Universal DMG/云端发布证据待补）。

## 本次完成内容

- 增加 `tests/compatibility/profile_contract.rs`，并在 `skillhub-adapters` 中注册为集成测试，验证每个内置客户端都声明 Windows/macOS 支持，路径模板只能展开到用户目录或项目目录，并且无本地目标的上传/云端客户端不会暴露可写部署能力。
- 增加 `tests/compatibility/platform_smoke.md`，固定发现、导入、部署、可见性、外部变化、收集、解除部署和恢复用例，并区分官方资料、文件接入已验证、无法判断和未安装等证据等级。
- 增加 Windows/macOS 验收记录；没有可操作 Agent 的设备明确写为“未安装—未进行真实机验证”，不从 profile 或另一操作系统推断结果。
- 增加 `docs/release-checklist.md`，记录当前候选提交的质量检查、产物信任级别、缺失证据和发布前人工确认项。
- 更新 Agent 平台兼容性调研，明确 Task11 的证据记录规则和真实客户端验证边界。

## 验证

- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-adapters --test profile_contract`：通过。
- 当前发布提交的 Rust workspace、前端 lint/TypeScript、307 项前端测试和生产构建已在 Task10/本次回归中通过。
- E2E、迁移/恢复、备份/恢复、性能、Universal DMG 和实际 Agent 文件接入尚未在本提交取得新证据，均在发布清单中保持待执行。

## 未完成边界

真实客户端验收需要用户设备上确实安装并可操作的 Agent；缺少客户端时不应为了“全绿”伪造通过记录。macOS Universal DMG 和 Windows NSIS 最终安装器也需要对应平台环境或云端工作流完成产物级验证。
