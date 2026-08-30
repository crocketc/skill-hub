# Plan 09 Task 21：桌面删除门面与影响对话框

## 当前状态

- Task 21.1–21.2 已完成，待 macOS 只读验收后收尾。
- 当前变更尚未提交。

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

## macOS 验证指令

应在 macOS `main` 分支同步本 Task 提交后只读执行：

```bash
./scripts/ci-local.sh
cd apps/desktop
./node_modules/.bin/vitest run src/features/removal/nativeApi.test.ts src/features/removal/RemovalImpactDialog.test.tsx
./node_modules/.bin/tsc --noEmit -p tsconfig.json
cd ../..
git diff --check
git status --short
```

仅验证，不修改源码、依赖、文档，不提交或推送。若镜像源不支持安全审计，临时切换官方 npm 源并在结束后恢复。

## 已知边界

- 当前提供的是删除原生门面和对话框能力，Skill 详情页的删除入口及完整业务页面状态仍需后续 UI 联调任务接入。
- 不生成平台专用导入包，不修改未知外部文件，不绕过集中库删除的关系和安全检查。
