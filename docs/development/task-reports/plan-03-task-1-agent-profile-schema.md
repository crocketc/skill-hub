# Plan 03 Task 1：Agent Profile Schema

状态：已完成

## 结果

- 建立 Agent profile、client、路径候选和部署能力的类型契约。
- 增加严格 JSON Schema 校验和自定义 profile 安全字段拒绝。
- 拒绝命令、脚本、shell、无限制根目录、路径穿越和不合规 URL。
- 处理 `schema.json` 不应被误加载为 profile 的边界。
- 完成 Windows/macOS 用户目录大小写和 URL 解析边界修复。

## 关键提交

- 初始实现：`5afa185`
- 修复提交：`8e479b0`、`f0496ea`、`d195962`
- 合并到 main：`ee999e8`

## 验证

- profile schema tests
- workspace tests
- fmt、Clippy、bindings 和 `git diff --check`

## 后续依赖

Task 2 使用本 Task 的 `ProfileCatalog`、严格 loader 和 schema；不推断 Agent 运行时可用性。
