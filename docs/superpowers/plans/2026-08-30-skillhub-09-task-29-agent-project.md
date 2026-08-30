# Plan 09 Task 29：Agent/项目事实接入 LocalApplicationFacade

## 目标

将已冻结的 Agent、项目、扫描和项目装配命令/查询接入真实本地 facade，复用现有 SQLite repository、扫描器和装配服务；只传播文件系统与配置事实，不推断 Agent runtime、授权或可执行性。

## 边界

- 修改 `crates/skillhub-application/src/lib.rs` 及其 facade 测试。
- 使用 native picker 解析后的 `ResolvedPathGrant`，拒绝未经登记的 opaque grant。
- 初始化扫描只注册发现目标与已登记项目，并通过现有 `ScanService` 做路径身份校验和结果持久化。
- 项目装配保留每项状态，版本解析基于本地集中库；来源获取、检查和部署仍由显式服务边界报告结果。
- 不触及 AI、备份、依赖或开发状态文档。

## 验收

```text
cargo test -p skillhub-application --test facade
cargo fmt --all -- --check
cargo check -p skillhub-application
cargo clippy -p skillhub-application --all-targets --all-features -- -D warnings
cargo test -p skillhub-desktop generate_bindings
git diff --check
```
