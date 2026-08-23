# Plan 03 Task 3：Agent 发现与物理目标合并

状态：已完成

## 结果

- 增加客户端实例、逻辑目标、物理目标和发现快照类型。
- 仅展开已注册的用户目录、项目目录等路径 token，不扫描全盘或无限制 home。
- 分离客户端存在事实与目录存在、可读、可写事实；无法确认客户端安装时记录 Unknown。
- 使用 Windows volume/file identity、Unix/macOS device/inode 和受限 fallback 合并物理目录。
- 保留不同逻辑路径指向同一物理目录的全部关系。
- 记录 macOS 卷大小写行为，保留观察到的路径大小写。
- 增加 SQLite 事务式快照替换、消失事实保留和失败回滚。
- 生成并校验 TypeScript bindings。

## 关键提交

- 初始实现：`4bd5c53`
- 修复提交：`7016595`、`5a974f7`
- 合并到 main：`bd4c5cd`

## 验证

- discovery、physical-target merge、repository tests
- workspace tests（包含 generate_bindings）
- fmt、Clippy 和 `git diff --check`

## 后续依赖

后续扫描、监听和部署任务只能消费这些发现事实，不能推断 Agent 登录、授权、信任、调用或 Skill runtime 可用性。
