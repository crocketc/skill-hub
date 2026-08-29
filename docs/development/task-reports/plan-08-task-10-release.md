# Plan 08 Task 10：Windows/macOS 早期发布工作流

状态：已完成（发布配置和工作流已完成；真实云端发布验收留给 Task 11）。

## 本 Task 完成内容

- 为桌面包增加锁定版本的 `@tauri-apps/cli` 和 `tauri` 构建脚本，保证从 `apps/desktop` 目录执行构建时使用同一 CLI 版本。
- 将 Tauri 构建前端命令改为桌面目录内的 `pnpm build`，避免从桌面目录执行时重复拼接路径。
- 增加 Windows NSIS 配置：当前用户安装模式，不把管理员权限作为安装前提。
- 增加 macOS ad-hoc Universal DMG 配置：同时声明 Intel 与 Apple silicon 目标，早期版本不宣称 Developer ID 签名或公证。
- 增加发布工作流：从同一语义版本 tag 检出源代码，执行 Rust/前端预检，构建 Windows x64/ARM64 和 macOS Universal 产物，生成 SHA-256、CycloneDX SBOM、提交溯源和信任级别元数据，并创建 Draft GitHub Release。
- 增加 Windows 未签名和 macOS 未公证安装说明；明确官方发布页、摘要核对和系统安全提示处理路径，不提供关闭 SmartScreen/Gatekeeper 的命令。

## 验证

- 三份 Tauri JSON 配置通过 JSON 解析校验。
- `.github/workflows/release.yml` 通过 YAML 解析校验；工作流固定 checkout、artifact 上传/下载动作版本，并校验发布 tag 格式。
- `pnpm install --frozen-lockfile --ignore-scripts`：通过。
- `pnpm --dir apps/desktop build`：通过。
- Windows x64 Tauri 构建已完成前端构建、Rust release 编译和应用产物生成；NSIS 最终打包需要从 GitHub 下载 Tauri NSIS 工具，当前本机网络策略中止了该下载，因此未取得本地 `.exe` 安装包。
- `git diff --check`：通过。

## 明确边界

早期发布工作流只创建 Draft Release，不自动公开发布；应用内更新检查仍遵循 Task 9 的信任闸门，未签名 Windows、ad-hoc/未公证 macOS 和未知信任级别只打开官方发布页。macOS Universal 的真实构建、云端 Release 产物和兼容性证据在 Task 11 执行。
