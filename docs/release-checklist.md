# SkillHub 发布检查清单

本清单用于每个候选发布提交。只有有新证据的项目才能标记为通过；没有执行或只依赖历史提交的项目保持待执行。

## 当前候选

- 提交：`2b27cc8`
- 日期：2026-09-04
- 发布信任级别：Windows 未签名；macOS ad-hoc、未公证
- 发布方式：GitHub Draft Release，人工核对后发布

## 证据状态

### 应用内更新发布链路（Task 6）

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| updater endpoint | 通过 | 固定为 `https://github.com/crocketc/skill-hub/releases/latest/download/latest.json` |
| Windows updater 资产 | 已配置 | `.nsis.zip` 与 `.sig`；首次安装 `.exe` 仍单独保留 |
| macOS updater 资产 | 已配置 | `.app.tar.gz` 与 `.sig`；首次安装 DMG 不进入 updater 清单 |
| latest.json | 已配置 | `scripts/generate_update_manifest.mjs` 生成四个平台条目 |
| 生产密钥 | 公钥已配置 | `TAURI_UPDATER_PUBLIC_KEY` 和匹配的 `TAURI_SIGNING_PRIVATE_KEY` 已配置；公钥变量与 `tauri.conf.json` 使用 `.pub` 文件的完整 base64 外壳，Rust 校验器使用其中的原始公钥行；无密码私钥无需设置密码 Secret |
| manifest 前端交接 | 已完成 | 检查查询返回当前平台 manifest/platform；设置页按“准备→下载→安装”调用原生契约，缺少清单时保留官方发布页兜底 |

| 检查项 | 状态 | 证据/备注 |
| --- | --- | --- |
| Rust 格式 | 通过 | `cargo fmt --all -- --check` |
| cargo-deny | 通过 | advisories/bans/licenses/sources 通过；重复 crate/yanked crate 为警告 |
| Rust Clippy | 通过 | `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` |
| Rust 测试 | 通过 | `cargo test --locked --workspace` |
| 前端依赖安装 | 通过 | `pnpm install --frozen-lockfile --ignore-scripts` |
| 前端审计 | 通过 | macOS 官方 registry 复核，0 个漏洞；用户镜像不支持端点时需临时切换官方源 |
| 前端 lint/TypeScript | 通过 | `pnpm check:frontend` |
| 前端测试 | 通过 | 当前 Windows 基线：71 个文件、377 项测试；macOS 最近基线已通过 |
| 前端生产构建 | 通过 | `pnpm --dir apps/desktop build` |
| 发布静态预检 | 通过 | `node scripts/verify_release_readiness.mjs` 与对应 Node 测试通过；工作流、Tauri 启动配置、tag-bound 约束、锁定 action、安装说明和 `dist/.gitkeep` 均通过 |
| 兼容性契约 | 通过 | `cargo test -p skillhub-adapters --test profile_contract` |
| 数据保护页面 | 通过（自动化） | `/settings/data-protection` 已接入备份包校验、恢复预检/冲突决策、组合导出；真实桌面文件烟测待执行 |
| 备份/恢复/导出 native facade | 通过（自动化） | typed preflight/commit 适配器与 Rust facade 测试通过 |
| E2E | 待执行 | 需要桌面运行时和可用测试环境 |
| 迁移/恢复 | 待执行 | 需要在本提交重新采集证据 |
| 备份/恢复 | 待执行 | 需要在本提交重新采集证据 |
| 性能基准 | 待执行 | 需要在本提交重新采集证据 |
| Windows NSIS | 待发布资产复核 | 代码和发布预检通过；真实签名安装需使用发布工作流生成的资产复核 |
| macOS Universal DMG | 环境受限/待资产复核 | 代码和发布预检通过；Universal 构建受本机 target/签名环境影响，需在发布环境复核 |
| Agent 真机接入 | 部分通过 | macOS Codex CLI、Claude Code 文件级通过；其余客户端未安装或未完成应用级接入 |

## 发布前人工确认

- [ ] Windows、macOS 构建均来自同一 tag 和提交，并完成双平台安装取证。
- [ ] 安装包 SHA-256、SBOM、提交溯源和信任级别元数据齐全。
- [ ] 安装说明没有要求关闭 SmartScreen/Gatekeeper 或运行绕过命令。
- [ ] Release 中没有 API Key、用户 Skill 正文、个人路径、`node_modules` 或 `target`。
- [ ] 未验证的 Agent、未完成的 E2E/真机项目没有被标记为通过。
- [ ] 应用更新清单、摘要和 minisign 签名已配置并与构建产物一致；清单缺失或校验失败时回退官方发布页。
