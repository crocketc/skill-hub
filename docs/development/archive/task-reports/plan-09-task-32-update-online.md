# Plan09 Task32：应用更新与在线来源搜索门面接入

## 状态

已完成并合并到 `main`。

## 完成内容

- 接通应用更新查询、官方 GitHub Release 地址校验和更新策略持久化。
- 接通在线来源搜索、网络关闭边界和 SQLite TTL 缓存。
- 保留构建信任门禁：未签名/未公证构建只返回官方发布页操作。
- 增加可注入 provider，保证测试不依赖真实网络。

## 验证

- `cargo test -p skillhub-application --test facade_online`
- `cargo test -p skillhub-application --tests`
- `cargo test -p skillhub-desktop generate_bindings`
- `cargo fmt --all -- --check`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `git diff --check`

以上专项验证在独立 worktree 通过；合并后的门面查询、组合/来源测试及 Clippy 复核通过。

## 边界

`OpenOfficialRelease` 负责校验并确认官方 URL；操作系统浏览器实际拉起仍由桌面层决定。
