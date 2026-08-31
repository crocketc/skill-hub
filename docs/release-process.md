# SkillHub 早期发布流程

本流程面向 Windows 和 macOS 的个人/早期体验发布，重点是可追溯和可复核，不把未签名或未公证构建伪装成正式受信任安装包。

## 发布输入

- 发布必须从一个明确的 Git tag 开始；Windows 与 macOS 工作流都检出同一个 tag。
- tag 对应的提交必须通过本地或 CI 的锁定依赖检查、Rust 检查、前端检查和测试。
- 发布前不得把 API Key、用户 Skill 内容、个人路径、`node_modules`、`target` 或 worktree 数据放入产物。

## 产物

| 平台 | 产物 | 信任级别 | 安装方式 |
| --- | --- | --- | --- |
| Windows x64 | NSIS `.exe` | 未签名 | 当前用户安装 |
| Windows ARM64 | NSIS `.exe` | 未签名 | 当前用户安装 |
| macOS Universal | `.dmg` | ad-hoc、未公证 | Finder 确认后手动打开 |

应用内更新使用独立的 Tauri updater 资产：Windows 为带签名的 `.nsis.zip`，macOS 为带签名的 `.app.tar.gz`。DMG 只用于首次安装，不写入 `latest.json` 的 updater 平台条目。

每个安装包都要有 SHA-256 摘要。发布工作流同时生成 CycloneDX SBOM 和发布元数据，其中元数据记录源提交、tag、构建平台、产物名称与信任级别。

## 发布步骤

1. 创建并推送版本 tag，或手动运行工作流并输入已有 tag。
2. 工作流在 Windows 与 macOS 上检出同一提交，安装锁定依赖，执行质量检查并构建平台产物。
3. 工作流生成校验和、SBOM 和发布元数据，创建 GitHub Draft Release；不会自动公开发布。
4. 发布者逐项核对提交号、产物名称、摘要、SBOM、安装说明和 CI 结果。
5. 确认无误后手动将 Draft Release 发布。正式签名构建会生成 `latest.json`，受信任构建可走应用内更新；未签名/未公证构建仍只打开官方发布页。

## 安全边界

- 发布工作流只从 CI Secret 读取 Tauri updater 私钥及密码，并从仓库变量读取与配置文件一致的公钥，不写入仓库、日志或产物。当前仓库中的公钥是测试 key；在第一次正式发布前，必须生成生产密钥对，将公钥同时替换 `tauri.conf.json` 与 `DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY`，再配置 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 和 `TAURI_UPDATER_PUBLIC_KEY`。早期构建不要求付费签名服务，但未配置这些值时不得声称支持应用内安装。
- 不提供绕过 SmartScreen 或 Gatekeeper 的命令，也不因为构建失败而跳过测试、审计或摘要生成。
- 未来启用受信任签名/公证时，应新增独立的信任门禁与回归证据，不能直接把早期未签名产物升级为自动安装渠道。
