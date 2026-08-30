# Plan 09 Task 21：桌面删除门面与影响对话框

## 当前状态

- Task 21.1–21.3 已完成并合并到 `main`。
- 提交：`d2dd341`。

## 完成内容

- 桌面 removal 原生门面新增集中库删除流程：先执行 `prepare_delete_skill`，再携带准备操作 ID 执行 `commit_delete_skill`。
- 前端删除选项到领域决策的映射固定为：
  - 保留部署文件并解除关系 → `keep_shared_deployment`；
  - 移除部署 → `remove_owned_target`；
  - 保留为独立副本 → `remove_relation_only`。
- 删除结果类型和错误结果类型均经过门面校验，不接受未知响应。
- 中英文对话框文案明确“保留为独立副本”的实际语义，避免误导为继续受 SkillHub 管理。
- 对话框继续要求每条部署关系明确选择；无部署关系时允许确认，依赖项目只展示提示，不自动级联修改。

## Windows 验证

- 完整本地 CI：10/10 通过。
- 删除原生门面定向测试：4/4 通过。
- 删除影响对话框测试：1/1 通过。
- TypeScript：通过。
- ESLint 与生产构建：包含于完整 CI，均通过。
- 构建导致的 `apps/desktop/dist/.gitkeep` 删除已恢复；pnpm registry 已恢复为 `https://registry.npmmirror.com`。

## macOS 验证结果

macOS 已在 `main` 的 `d2dd341` 上只读完成验收：

```bash
./scripts/ci-local.sh
cd apps/desktop
./node_modules/.bin/vitest run src/features/removal/nativeApi.test.ts src/features/removal/RemovalImpactDialog.test.tsx
./node_modules/.bin/tsc --noEmit -p tsconfig.json
cd ../..
git diff --check
git status --short
```

- 完整本地 CI：10/10 通过。
- `nativeApi.test.ts`：4/4 通过。
- `RemovalImpactDialog.test.tsx`：1/1 通过。
- TypeScript：通过。
- 未修改源码、依赖或文档；仅保留构建副作用 `.gitkeep` 删除和本地 `.DS_Store` 未跟踪文件。
- pnpm 使用官方源，安全审计 0 个漏洞。

## 已知边界

- 当前提供的是删除原生门面和对话框能力，Skill 详情页的删除入口及完整业务页面状态仍需后续 UI 联调任务接入。
- 不生成平台专用导入包，不修改未知外部文件，不绕过集中库删除的关系和安全检查。
