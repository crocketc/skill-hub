# Plan 08 Task 8：供应链策略与 SBOM

状态：已完成。

## 本 Task 完成内容

- 增加前端生命周期脚本的精确审阅清单和 Windows/macOS 检查入口；检查只读取锁定依赖和已安装包元数据，不执行第三方脚本。
- 增加 Cargo、npm 和 GitHub Actions 的 Dependabot 配置。
- 供应链工作流覆盖 cargo-deny 四类检查、锁定依赖安装、生命周期 allowlist、前端生产依赖审计、生成 bindings 漂移检查和常见凭据格式扫描。
- 增加不依赖额外 SBOM 工具的 CycloneDX Rust、前端和合并清单生成器，输出不含凭据和本机绝对路径。
- 为 `skillhub-cli` 的本地核心依赖补齐版本约束，消除 cargo-deny 的 wildcard 阻断项。
- 将生命周期脚本审阅加入跨平台本地 CI，安装依赖后先执行 allowlist 检查。

## 验证

- `cargo deny check advisories bans licenses sources`：通过；重复 crate 和 yanked crate 仍作为可见警告。
- `pwsh -NoProfile -File scripts/verify_frontend_lifecycle_scripts.ps1`：通过，59 个包身份均有明确审阅记录。
- `pnpm audit --prod --registry=https://registry.npmjs.org`：通过，无已知漏洞。
- `node scripts/generate_sbom.mjs --out-dir .tmp-sbom`：通过，生成 574 个 Rust 和 605 个前端组件；输出 JSON 和 UUID 校验通过。
- `cargo fmt --all -- --check`、`cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`、`cargo test --locked --workspace`：通过。
- `git diff --check`：通过。

## 明确边界

供应链工作流使用 `--ignore-scripts` 安装依赖，allowlist 只表达人工审阅事实，不授权 CI 执行第三方生命周期脚本。SBOM 是当前锁定图的清单基线，不替代发行版签名、漏洞修复策略和后续正式发布流程。npm 审计需要官方 registry 或提供审计端点的镜像；本地镜像不支持该端点时应明确提示而不是误报漏洞。
