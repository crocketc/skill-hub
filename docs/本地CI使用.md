# 本地 CI 使用说明

SkillHub 的本地 CI 在 Windows 和 macOS 上执行同一套质量检查，不依赖 GitHub Actions 云端额度。

## 前置环境

- Rust stable，并包含 `rustfmt` 和 `clippy`
- `cargo-deny`
- Node.js 22
- pnpm 11.21

两台设备使用仓库中的 `Cargo.lock`、`pnpm-lock.yaml` 和相同的检查命令，避免因为依赖版本不同得到不同结果。

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

## 两台设备的协作方式

代码通过 GitHub 分支同步，不同步 `.git`、`node_modules` 或 worktree。开发设备推送分支后，另一台设备执行 `git pull --ff-only`，再运行对应系统的本地 CI 入口。

Skill 集中库、API Key 和个人配置不属于代码仓库，不应提交到 Git。
