# SkillHub 发布检查清单

本清单用于每个候选发布提交。只有有新证据的项目才能标记为通过；没有执行或只依赖历史提交的项目保持待执行。

## 当前候选

- 提交：Task11 验收工作树（基于 Task10 提交 `b80652f`）
- 日期：2026-08-29
- 发布信任级别：Windows 未签名；macOS ad-hoc、未公证
- 发布方式：GitHub Draft Release，人工核对后发布

## 证据状态

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| Rust 格式 | 通过 | `cargo fmt --all -- --check` |
| cargo-deny | 通过 | advisories/bans/licenses/sources 通过；重复 crate/yanked crate 为警告 |
| Rust Clippy | 通过 | `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` |
| Rust 测试 | 通过 | `cargo test --locked --workspace` |
| 前端依赖安装 | 通过 | `pnpm install --frozen-lockfile --ignore-scripts` |
| 前端审计 | 待在发布环境复核 | 官方 registry 通过；镜像若无审计端点需切换官方源 |
| 前端 lint/TypeScript | 通过 | `pnpm check:frontend` |
| 前端测试 | 通过 | 52 个文件、307 项测试 |
| 前端生产构建 | 通过 | `pnpm --dir apps/desktop build` |
| 兼容性契约 | 通过 | `cargo test -p skillhub-adapters --test profile_contract` |
| E2E | 待执行 | 需要桌面运行时和可用测试环境 |
| 迁移/恢复 | 待执行 | 需要在本提交重新采集证据 |
| 备份/恢复 | 待执行 | 需要在本提交重新采集证据 |
| 性能基准 | 待执行 | 需要在本提交重新采集证据 |
| Windows NSIS | 环境受限 | Rust release 编译通过；NSIS 工具下载被本机网络策略中止 |
| macOS Universal DMG | 待执行 | 必须在 macOS runner/设备验证 |
| Agent 真机接入 | 待执行 | 未安装客户端统一记录为未验证 |

## 发布前人工确认

- [ ] Windows、macOS 构建均来自同一 tag 和提交。
- [ ] 安装包 SHA-256、SBOM、提交溯源和信任级别元数据齐全。
- [ ] 安装说明没有要求关闭 SmartScreen/Gatekeeper 或运行绕过命令。
- [ ] Draft Release 中没有 API Key、用户 Skill 正文、个人路径、`node_modules` 或 `target`。
- [ ] 未验证的 Agent、未完成的 E2E/真机项目没有被标记为通过。
- [ ] 应用更新仍只对未签名/未公证构建提供官方发布页操作。
