# Plan 09 Task 33：最终发布与联调收口审计

状态：已完成（确定性预检和桌面启动/构建路径缺口已补齐；真实云端产物和 Agent 真机验收仍按发布清单保持独立门槛）。

## 本次审计

- 检查 Plan 08 发布工作流、Tauri Windows/macOS 配置、root/desktop 前端命令、Specta bindings 检查入口、本地 CI 入口和发布安装说明。
- 发现并修复 Tauri 开发启动缺口：桌面包缺少 `dev` 脚本，且 `beforeDevCommand` 使用了依赖当前工作目录的 root 路径；改为桌面包内的 `pnpm dev` 和 `vite`。
- 发现前端构建会删除已跟踪的 `apps/desktop/dist/.gitkeep`；新增 `postbuild` 恢复脚本，覆盖 root 前端构建、桌面目录构建以及 Tauri 前置构建路径。
- 新增 `pnpm verify:release` 确定性静态预检，核对发布输入、命令路径、Tauri 配置、Draft/tag 约束、发布 action SHA、安装说明安全边界和占位文件状态；提供 JSON 输出便于 CI 或人工留证。
- 补充 Windows/macOS 本地 CI 文档中的 Tauri 启动、发布预检和占位文件行为说明；发布清单增加预检证据项。

## 验证

- `node --test scripts/verify_release_readiness.test.mjs`：2/2 通过。
- `node scripts/verify_release_readiness.mjs --json`：通过，`failures=[]`。
- 测试覆盖预检成功路径和在临时目录中恢复 `.gitkeep` 的行为；构建工具未在本任务中重复下载或打包平台安装器。

## 未解决边界

- 真实 Universal DMG/Windows NSIS、云端 Draft Release、E2E、迁移/备份性能和 Agent 真机证据仍需在相应平台或云端环境执行，不能由静态预检替代。
- 本任务未修改 `docs/development/当前开发状态.md`，由主 Agent 在收口时统一更新。
