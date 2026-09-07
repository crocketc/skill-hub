# Plan 10 Task 7 应用内更新双平台验收

更新时间：2026-08-31

## 验收基线

- 当前提交：`3cb15f8`（包含 Task 7 staging 测试夹具修复及验收记录）
- 验收方式：Windows 当前 `main` 工作区先行；macOS 使用同一提交只读复核
- 安全边界：当前仓库仍使用测试 updater 公钥，没有生产私钥或已签名发布资产；因此不把应用内安装、自动重启和回滚写成已验证通过

## Windows

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| Rust 格式 | 已执行 | 通过 |
| 发布静态预检 | 通过 | `pnpm run verify:release` |
| 发布预检测试 | 通过 | `node --test scripts/verify_release_readiness.test.mjs`，5/5 |
| 前端质量门禁 | 通过 | `pnpm --dir apps/desktop run check`、全量 Vitest 346/346、生产构建通过 |
| 完整本地 CI | 环境阻塞 | cargo-deny 在下载锁定 crate 时无法连接 `static.crates.io`；授权重跑超过 90 秒无进展后停止 |
| Windows NSIS/updater 安装 | 待执行 | 当前无生产签名资产，不能进行真实应用内安装取证 |
| SmartScreen 行为 | 待执行 | 仅在实际未签名安装包生成后记录，不提供绕过命令 |

### 已修复的跨平台回归

Mac 首次验收发现 `facade_update::install_with_injected_installer_launches_platform_install_and_keeps_rollback_marker` 仅写入待安装元数据、未创建 staging 包，触发了正确的“包不存在”保护。提交 `15f8b44` 为测试夹具创建临时包文件；生产安装校验未修改。Windows 与 Mac 需在该提交上重新跑完整 CI。

## macOS

- 分支：`main`，提交：`3cb15f8`
- `pnpm run verify:release`：通过
- `node --test scripts/verify_release_readiness.test.mjs`：5/5 通过
- `cargo test -p skillhub-application --test facade_update`：9/9 通过
- `./scripts/ci-local.sh`：10/10 通过；前端安全审计 0 漏洞，未切换 npm 源
- `git diff --check`：通过；无跟踪文件修改，仅保留 `.DS_Store`
- 未进行真实应用安装、自动重启或回滚：当前没有生产签名资产

验收使用的只读命令如下：

```bash
git fetch origin
git switch main
git pull --ff-only
pnpm run verify:release
node --test scripts/verify_release_readiness.test.mjs
./scripts/ci-local.sh
```

若本机镜像出现 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`，只允许临时切换官方 npm registry 重跑 CI，结束后恢复原 registry；不要升级依赖或修改仓库文件。请额外记录是否具备 `x86_64-apple-darwin` 编译目标、DMG 和 `.app.tar.gz` 产物；没有生产签名密钥时，真实 updater 安装仍标记为未验证。

## 未解决问题

1. 生产 updater 密钥对尚未生成/配置；工作流会拒绝测试公钥和缺失 Secret。
2. Task 5 记录的 manifest 前端契约缺口仍保留，设置页继续提供官方发布页备用入口。
3. Windows 完整 CI 需要网络可访问 Rust crate 源后重跑；macOS 完整 CI 已在 `3cb15f8` 补齐并通过。

## 收口条件

只有 Windows 与 macOS 都有同一提交的完整 CI、发布预检和真实签名资产证据，并分别记录安装、重启与失败边界后，Task 7 才能标记完成。
