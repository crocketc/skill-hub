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

应用内更新使用独立的 Tauri updater 资产：Windows 为带 minisign 签名的 `.nsis.zip`，macOS 为带 minisign 签名的 `.app.tar.gz`。DMG 只用于首次安装，不写入 `latest.json` 的 updater 平台条目。操作系统代码签名/公证仍是独立能力；没有付费 Developer ID 或 Authenticode 证书时，首次安装可能出现系统提示，但应用内更新仍可依靠清单、摘要和 minisign 校验完成。

每个安装包都要有 SHA-256 摘要。发布工作流同时生成 CycloneDX SBOM 和发布元数据，其中元数据记录源提交、tag、构建平台、产物名称与信任级别。

GitHub Release 只公开首次安装包、应用内更新包、签名文件和 `latest.json`。SHA-256、SBOM、发布元数据、来源证明和详细安装说明作为 GitHub Actions 的独立发布证据保存，不混入普通用户下载列表。

## 发布步骤

1. 创建并推送版本 tag，或手动运行工作流并输入已有 tag。
2. 工作流在 Windows 与 macOS 上检出同一提交，安装锁定依赖，执行质量检查并构建平台产物。
3. 工作流生成校验和、SBOM 和发布元数据，上传为独立的发布证据，并创建只包含安装/更新必需资源的 GitHub Draft Release；不会自动公开发布。
4. 发布者逐项核对提交号、产物名称、摘要、SBOM、安装说明和 CI 结果。
5. 确认无误后手动将 Draft Release 发布。只要配置了免费的 minisign 密钥并生成 `latest.json`，应用会优先走“检查→下载→校验→安装→自动重启”；清单缺失、平台不匹配或校验失败时才回退到官方发布页。首次安装的未签名/未公证包仍按平台安全提示操作。

## 安全边界

- 发布工作流只从 CI Secret 读取 Tauri updater 私钥（密码可选），并从仓库变量读取与配置文件一致的公钥，不写入日志或产物。Tauri v2 已内置 signer，不使用 `minisign -G`：在项目目录执行 `pnpm --dir apps/desktop tauri signer generate -- -w ~/.tauri/skillhub.key`（Windows PowerShell 可将路径改为 `$env:USERPROFILE\\.tauri\\skillhub.key`）。如果私钥设置了密码，再将密码保存为 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；无密码私钥无需创建该 Secret。私钥文件内容保存为 `TAURI_SIGNING_PRIVATE_KEY`。注意：Tauri 配置和 `TAURI_UPDATER_PUBLIC_KEY` 必须使用 `.pub` 文件的完整 base64 外壳（通常以 `dW50cnVzdGVk...` 开头），而应用内 Rust 校验器使用其中的原始公钥行（`DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY`）；两者来源相同但字符串格式不同。Windows 配置使用 `createUpdaterArtifacts: \"v1Compatible\"` 以生成 `.nsis.zip` 更新包，macOS 使用 `.app.tar.gz`。私钥绝不提交仓库或发送给他人。当前仓库已切换为生产公钥；只有与这把私钥匹配的签名资产才能通过应用内更新校验。未配置私钥时只能发布首次安装包，不能声称支持应用内安装。
- 不提供绕过 SmartScreen 或 Gatekeeper 的命令，也不因为构建失败而跳过测试、审计或摘要生成。
- 未来启用受信任签名/公证时，应新增独立的信任门禁与回归证据，不能直接把早期未签名产物升级为自动安装渠道。
