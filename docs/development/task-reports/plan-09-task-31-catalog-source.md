# Plan09 Task31：目录、组合与来源操作门面接入

## 状态

已完成并合并到 `main`。

## 完成内容

- 接通 Skill 创建、组合创建与列表、当前版本切换、项目版本固定。
- 接通本地来源重连、来源更新检查和显式更新决策。
- 为组合和来源关系增加 SQLite 持久化支持。
- 更新 Specta 绑定所需的应用层返回路径。

## 验证

- `cargo test -p skillhub-application --test facade_catalog_source`
- `cargo test -p skillhub-application --test facade`
- `cargo test -p skillhub-storage --quiet`
- `cargo clippy -p skillhub-storage -p skillhub-application --all-targets -- -D warnings`
- `cargo fmt --all -- --check`
- `git diff --check`

以上专项验证在独立 worktree 通过；合并后主分支专项测试再次通过。

## 边界

- 远程来源获取尚未接入本地门面，沿用已有来源适配边界。
- `CreateIndependentBranch` 在当前存储能力不足时返回结构化冲突，不伪造分支结果。
