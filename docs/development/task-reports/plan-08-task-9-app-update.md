# Plan 08 Task 9：应用更新检查与信任策略

状态：已完成。

## 本 Task 完成内容

- 增加 `BuildTrust`、`ApplicationUpdate`、`CheckApplicationUpdate`、`OpenOfficialRelease` 和 `SetApplicationUpdatePolicy` 类型，并加入 Rust/Specta API bindings。
- 增加 GitHub 官方 Release 查询适配器：只接受 `owner/name` 仓库和 HTTPS 官方 GitHub 发布页，校验版本号、发布地址和网络开关。
- 应用更新策略持久化到现有 SQLite `settings` 表，默认启用手动检查、不在启动时自动联网检查。
- 未签名 Windows、ad-hoc macOS 和未知构建只返回“打开官方发布页”；受信任构建才会返回已验证安装动作。
- 应用更新检查失败或关闭网络时，不影响本地数据库启动和 Skill 管理功能。

## 验证

- Core 模型测试：信任闸门、版本比较和官方 URL 校验通过。
- GitHub Release 适配器测试：本地 HTTP fixture、版本解析、官方 URL 校验和网络关闭路径通过。
- SQLite 仓储测试：策略默认值和保存/读取往返通过。
- API bindings 生成漂移检查通过。
- `cargo fmt --all -- --check`、`cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`、`cargo test --locked --workspace`：通过。

## 明确边界

当前只提供检查、策略保存和官方发布页/已验证安装动作的契约；没有启用未签名或未公证构建的静默安装，也没有把应用更新策略复用为 Skill 自动升级策略。真实 GitHub 线上请求、平台安装器签名和 Universal DMG/NSIS 发布属于后续 Task10/11。
