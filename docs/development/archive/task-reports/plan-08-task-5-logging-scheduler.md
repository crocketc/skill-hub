# Plan 08 Task 5：本地日志脱敏与应用内调度

状态：已完成并进入 `main`。

## 本 Task 完成内容

- 本地日志事件保留事件码、操作 ID、阶段、耗时和计数，参数中的 API key、Token、密码、凭据、Bearer 值和 Skill 正文会被脱敏。
- `LocalLogConfig` 支持写入应用目录并按大小滚动日志文件；日志不上传、不包含完整 Skill 内容。
- `RuntimeScheduler` 提供应用内任务生命周期：任务由应用持有，停止时中止并等待，不安装系统服务或后台常驻进程。
- 增加日志隐私和调度退出测试，覆盖敏感数据不落盘及停止后无运行任务。

## 验证

- `cargo test --locked --workspace`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-adapters --test log_privacy`：通过。
- `cargo test -p skillhub-core --test scheduler_lifetime`：通过。
- `git diff --check`：通过。

## 明确边界

本 Task 不实现云端日志、崩溃上传、系统级服务、托盘常驻或后台守护进程。调度器只负责应用打开期间的任务生命周期，扫描、更新和备份任务的具体业务接入由后续 ApplicationFacade 联调完成。
