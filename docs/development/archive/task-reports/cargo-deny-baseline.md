# cargo-deny 基线专项

状态：已完成，等待独立专项 PR 审查

## 处理内容

- 将 `deny.toml` 迁移到 cargo-deny v2 配置格式。
- 为五个 workspace crate 补充 `MIT` 许可证元数据。
- 为 workspace path 依赖补充精确版本 `0.1.0`，消除 wildcard 依赖错误。
- 明确允许当前依赖图实际使用的 `MPL-2.0`、`Zlib`、`Apache-2.0 WITH LLVM-exception` 和 `CDLA-Permissive-2.0`。
- 将 unmaintained 策略设为 `workspace`：workspace 直接依赖仍失败，Tauri 带入的 GTK3、`proc-macro-error` 和 `unic-*` 传递依赖保留为警告，避免用 advisory 白名单掩盖问题。

## 处理边界

- 未降低 duplicate crate 的检查级别；现有 `multiple-versions = "warn"` 保持不变。
- 未通过 advisory 白名单、通配符忽略或放宽 sources 检查来掩盖问题；传递依赖维护告警仍会显示。
- 本专项只处理仓库依赖治理，不改变 UI PR 的业务代码。
- workspace crate 的许可证元数据采用 MIT；正式分发前仍需确认仓库是否要补充对应的 LICENSE 文本文件。

## 验证

- `cargo deny check advisories bans licenses sources`：通过（cargo-deny 0.20.2，最新本地 RustSec 数据库）。
- `cargo metadata --locked`：通过。
- `cargo deny check bans licenses sources --disable-fetch --hide-inclusion-graph`：通过。

剩余输出为 duplicate crate 警告，不阻断 CI，后续可在依赖升级专项中单独治理。
