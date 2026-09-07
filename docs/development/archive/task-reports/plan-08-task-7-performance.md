# Plan 08 Task 7：性能夹具与发布验收基线

状态：已完成并进入 `main`。

## 本 Task 完成内容

- 使用固定种子生成 100/300 Skill 的小、中、大 Markdown、代码块、表格和标签夹具。
- 测量缓存启动、全量扫描、搜索、备份恢复和批量部署五类操作，并打印包含种子、数量和耗时的 JSON 报告。
- 报告不包含 Skill 正文、开发者路径、CPU 标识或网络数据；非参考机器只记录指标，不使用脆弱的机器相关断言。
- 增加可手动或定时运行的 GitHub Actions 性能工作流。

## 验证

- `cargo test -p skillhub-core --test performance_suite -- --nocapture`：通过。
- `cargo clippy -p skillhub-core --test performance_suite -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test --locked --workspace`：通过。
- `git diff --check`：通过。

## 明确边界

当前夹具和报告是可重复的基准骨架，尚未把具体 Windows/macOS 参考硬件阈值作为强制发布门禁。真实桌面运行时性能、SQLite 投影和 UI 联调需在后续验收阶段补充。
