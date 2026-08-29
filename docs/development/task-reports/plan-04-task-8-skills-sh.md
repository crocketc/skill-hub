# Plan 04 Task 8：skills.sh 在线发现

## 状态

已完成并提交到 `main`：`575c10b feat: add direct skills.sh source discovery`。

## 完成内容

- 增加来源搜索查询、搜索命中和分页结果模型，支持查询词、limit、owner、来源类型、安装链接、页面链接、安装量和重复标记。
- 增加 `SkillsShProvider`，使用 skills.sh 官方 `/api/v1/skills/search` JSON API；不依赖 Vercel CLI，不抓取 HTML。
- GitHub 结果映射为 Git 来源，well-known 结果映射为 HTTPS 来源；保留稳定 `source_id` 与页面链接供导入流程继续使用。
- 处理 `Cache-Control: max-age`、429 `Retry-After`、401 认证不可用、其他 HTTP 错误和全局网络关闭，全部返回结构化错误。
- 增加 `SearchOnlineSources` 查询契约和 `SourceSearchPage` 结果契约，并重新生成 TypeScript bindings。
- 增加 SQLite 搜索响应缓存，按查询内容稳定寻址，并严格按 TTL 判断是否新鲜。

## 验证

- `cargo test --locked --workspace`：通过。
- `cargo test -p skillhub-adapters --test skills_sh`：通过。
- `cargo test -p skillhub-storage --test source_search_cache`：通过。
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p skillhub-desktop generate_bindings`：通过。
- `git diff --check`：通过。

## 未包含范围

- skills.sh 真实网络调用的产品 UI、导入向导接入和在线结果与本地 Skill 的最终合并由桌面业务联调阶段完成。
- 第三方审计接口不在本 Task 范围内，不能替代 SkillHub 基础检查或可选 LLM 检查。
