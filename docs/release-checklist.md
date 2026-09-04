# SkillHub 发布检查清单

本清单用于每个候选发布提交。只有有新证据的项目才能标记为通过；没有执行或只依赖历史提交的项目保持待执行。

## 当前候选

- 提交：`7f17d9c`
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
| 初始化扫描后台交接 | 通过（自动化） | 扫描运行超过 10 秒可转入后台并完成初始化；原生扫描仍继续执行，未伪造取消或进度 |
| 初始化完成默认进入批量导入 | 通过（自动化） | 扫描发现来源目录后，“完成初始化”会先完成初始化再直接进入批量导入；跳过扫描仍可回到概览 |
| Agent 识别与扫描范围确认 | 通过（自动化） | 未完成 Agent 识别、选择和只读确认时不能继续；扫描使用明确选择的目标，避免空选择隐式扫描全部目标 |
| 初始化批量导入引导 | 通过（自动化） | 扫描完成后直接进入导入向导；全部来源默认选中，候选列表支持全选，冲突审阅与提交确认仍保留 |
| 扫描来源批量选择 | 通过（自动化） | 导入页保留全部扫描来源并默认全选；多个来源在同一流程中获取候选并合并审阅 |
| 本地目录弹窗选择 | 通过（自动化） | Tauri 原生目录选择器已接入导入页；手动路径仍保留为备用入口，项目和自定义 Agent 可复用同一目录选择器接口 |
| 导入失败详情 | 通过（自动化） | 原生错误代码和参数会显示在每项失败结果中；无详情时明确提示未返回错误详情 |
| Windows 扩展路径显示 | 通过（自动化） | `\\?\` 扩展路径前缀在导入请求和候选展示中统一规范化，不再暴露给用户，也不改变实际文件定位 |
| 冲突决策兼容性 | 通过（自动化） | “独立导入”按原生分析结果映射为 `keep_independent` 或 `copy_as_independent_managed_skill`，避免 `input.invalid field=decision` |
| 冲突流程二次进入 | 通过（自动化） | 返回来源重新解析或重试时清理旧决策；每个必选冲突需重新选择，选择后“提交导入”恢复可用 |
| 导入准备决策一致性 | 通过（自动化） | 提交阶段直接依据本次原生 `prepare_import` 返回的允许决策，避免二次分析状态差异导致 `input.invalid` |
| 导入提交进度可见 | 通过（自动化） | 提交每个候选前后报告完成数、总数和当前候选；大目录同步捕获期间不再只显示无变化的通用文案 |
| 远程来源提示边界 | 通过（自动化） | URL、Git 和 npx 来源可识别但当前只做解析提示；远程下载导入未接入时明确告知用户并保留本地目录导入路径 |

## 发布前人工确认

- [ ] Windows、macOS 构建均来自同一 tag 和提交，并完成双平台安装取证。
- [ ] 安装包 SHA-256、SBOM、提交溯源和信任级别元数据齐全。
- [ ] 安装说明没有要求关闭 SmartScreen/Gatekeeper 或运行绕过命令。
- [ ] Release 中没有 API Key、用户 Skill 正文、个人路径、`node_modules` 或 `target`。
- [ ] 未验证的 Agent、未完成的 E2E/真机项目没有被标记为通过。
- [ ] 应用更新清单、摘要和 minisign 签名已配置并与构建产物一致；清单缺失或校验失败时回退官方发布页。
