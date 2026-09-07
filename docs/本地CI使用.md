# 本地 CI 使用说明

SkillHub 的本地 CI 在 Windows 和 macOS 上执行同一套质量检查，不依赖 GitHub Actions 云端额度。

## 前置环境

- Rust stable，并包含 `rustfmt` 和 `clippy`
- `cargo-deny`
- Node.js 22（与 GitHub Actions 基线一致）
- pnpm 11.21

两台设备使用仓库中的 `Cargo.lock`、`pnpm-lock.yaml` 和相同的检查命令，避免因为依赖版本不同得到不同结果。

macOS 本地验证也已在 Node.js 24 上通过。Node.js 24 可用于本地检查；如果要尽量复现云端环境，优先使用 Node.js 22。项目已加入 Node 24 与 jsdom/React Router 的 `AbortSignal` 跨 realm 兼容处理，不需要为此升级依赖。

## Windows 11

在仓库根目录打开 PowerShell：

```powershell
.\scripts\ci-local.ps1
```

也可以直接调用统一入口：

```powershell
node .\scripts\ci-local.mjs
```

## macOS

在仓库根目录打开终端：

```bash
chmod +x ./scripts/ci-local.sh
./scripts/ci-local.sh
```

也可以直接运行：

```bash
node ./scripts/ci-local.mjs
```

## 检查内容

脚本会按顺序执行 Rust 格式、依赖与许可证策略、Clippy、Rust 测试、前端依赖安装与审计、Lint、TypeScript、Vitest 和生产构建。任一步失败都会立即停止，并标明失败阶段。

查看检查清单但不执行：

```bash
node ./scripts/ci-local.mjs --list
```

## 桌面端启动与发布预检

Tauri 的开发和构建前置命令都在 `apps/desktop` 包目录内执行。启动桌面壳时使用：

```powershell
pnpm --dir apps/desktop tauri dev
```

```bash
pnpm --dir apps/desktop tauri dev
```

发布前可运行不依赖网络或构建工具的确定性静态预检；它会核对 root/desktop 命令路径、Tauri Windows/macOS 配置、tag-bound 发布工作流、锁定 action 引用、安装说明安全边界和前端 `dist/.gitkeep` 占位文件：

```bash
pnpm verify:release
```

如需运行该预检的自动化回归测试：

```bash
pnpm test:release
```

前端构建会清空 `apps/desktop/dist`。`build` 的 `postbuild` 钩子会恢复已跟踪的 `.gitkeep`，因此本地 CI 或发布预检完成后不应留下该占位文件的删除状态；若发现异常，先运行 `pnpm verify:release` 并检查 `git status`。

## 前端安全审计与 npm 镜像

前端安全审计需要 pnpm 能访问 npm audit 接口。部分镜像（例如 `https://registry.npmmirror.com`）可以正常安装依赖，但不提供 pnpm 所需的审计端点，因此会在“前端依赖审计”阶段失败。这是镜像能力差异，不是项目依赖本身必然存在漏洞。

遇到 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS` 时，可临时切换到官方 npm 源完成一次完整 CI，然后恢复原来的用户配置：

```bash
pnpm config get registry --location=user
pnpm config set registry https://registry.npmjs.org --location=user
./scripts/ci-local.sh
pnpm config delete registry --location=user
```

如果原本配置的是其他用户级源，应在切换前记录并在 CI 后恢复原值。只在审计需要时切换即可，日常安装依赖仍可使用原镜像。

## 两台设备的协作方式

代码通过 GitHub 分支同步，不同步 `.git`、`node_modules` 或 worktree。开发设备推送分支后，另一台设备执行 `git pull --ff-only`，再运行对应系统的本地 CI 入口。

Skill 集中库、API Key 和个人配置不属于代码仓库，不应提交到 Git。

本地 CI 可能产生 pnpm 缓存目录（例如 `.pnpm-store/`）和系统元数据文件；这些属于本机临时内容，不应提交。双设备同步前只同步 Git 中的已跟踪文件和提交。
