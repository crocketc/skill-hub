# Plan 09 Task 12：部署写入与桌面部署对话框集成报告

## 当前提交

- Windows/macOS 集成分支：`main`
- 验收提交：`ca42c37`
- 远端：`origin/main`

## 已完成内容

- `list_deployment_targets` 查询只返回发现快照中已登记的逻辑目标，不扫描任意目录。
- 生产 ApplicationFacade 会基于可用发现目标构建受 PathPolicy 保护的目标索引。
- 桌面部署对话框已接入原生查询和命令：目标列表 → 预览 → 确认提交。
- 当前版本路由会先读取实际当前版本和运行时名称，再生成预览请求。
- 提交结果按目标保留成功/失败状态；失败不会隐藏，也不会删除集中库源文件。
- 原生绝对路径只用于目标展示和后端安全校验，不拼接到错误消息中。

## Windows 验证

2026-08-30 在 Windows 11 使用官方 npm registry 临时复核后运行 `scripts/ci-local.ps1`，结束后恢复原镜像。

- Rust 格式、cargo-deny、Clippy、workspace 测试：通过。
- 前端依赖、生命周期策略、安全审计：通过，0 个漏洞。
- ESLint、TypeScript：通过。
- Vitest：57 个测试文件、323 个测试全部通过。
- 生产构建：通过，仅有既有大体积分块警告。

## macOS 验证

2026-08-30 在 macOS 的 `main@ca42c37` 上完成验证，未修改源码、依赖、配置或 Git。

- 3 个此前超时的测试单独运行均通过：Sidebar 4/4、ConfirmDialog 2/2、SkillLibraryPage 34/34。
- 全量 Vitest：57 个测试文件、323 个测试全部通过。
- TypeScript、ESLint、Vite 生产构建：全部通过；仅有大分块警告。
- Rust 格式、cargo-deny、Clippy、workspace 测试：通过。
- 前端依赖、生命周期策略、安全审计：通过，0 个漏洞。
- 部署定向测试拆分运行后通过：deployment plan 3/3，deployment command 1/1。
- 初次完整 CI 的超时归类为 macOS 完整运行负载波动，未修改测试超时配置。

## 已知边界

- 当前发现快照只声明受管复制能力；软链接/目录联接能力仍需 Agent profile 明确声明后再开放。
- 部署成功代表文件系统写入和关系记录成功，不代表目标 Agent 已加载、调用或正确执行 Skill。
- 本 Task 验证的是应用门面、注册目标、受管复制和回滚安全边界；未将 Universal DMG 交叉编译或所有第三方 Agent 真机覆盖作为阻断条件。
- 本报告不记录本机路径、用户 Skill 内容、凭据或依赖缓存。
