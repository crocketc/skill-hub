# Plan 08 Task 6：数据库升级恢复点与回滚

状态：已完成并进入 `main`。

## 本 Task 完成内容

- 数据库打开和迁移前在同一卷创建恢复点，避免跨设备复制和远端上传。
- 迁移成功且新数据库可打开后删除恢复点；打开失败、迁移失败或外键初始化失败时恢复原数据库文件。
- 恢复点命名带时间戳，失败处理后清理临时侧车文件，不改变用户原始数据库内容。
- 增加损坏数据库、既有数据库迁移和恢复点生命周期测试。

## 验证

- `cargo test --locked --workspace`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-storage --test database_upgrade`：通过。
- `cargo test -p skillhub-storage --test migrations`：通过。
- `git diff --check`：通过。

## 明确边界

本 Task 只保护 SQLite 文件升级过程，不改变迁移 SQL 和业务投影结构；备份恢复后的完整数据库重建、性能验收和真实 ApplicationFacade 接入由后续 Task 完成。
