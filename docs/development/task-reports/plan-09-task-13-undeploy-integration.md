# Plan09 Task13：解除部署与安全脱离集成报告

## 完成内容

- 本地 ApplicationFacade 接入 `GetRemovalImpact`、`PrepareUndeploy`、`CommitUndeploy` 和 `DetachManagement`。
- 解除部署影响从已持久化的活动部署关系生成，只使用注册目标记录，不接受调用方传入任意文件路径。
- 受管复制删除复用 `DeploymentFilesystem` 的所有权证明，验证目标物理身份和目录树哈希；目标被修改时返回结构化 `OwnershipMismatch`，不删除文件、不移除关系。
- 仅移除关系会保留目标文件并把历史关系标记为 `removed`；解除管理只把关系的 `managed` 标记置为 false。
- 增加 SQLite 部署关系的同步状态更新方法。
- 桌面端新增原生解除部署门面，按“准备 → 明确决定 → 提交”调用类型化 IPC；支持影响查询、解除部署和解除管理。

## 测试

- `cargo test -p skillhub-application --test facade`：20/20 通过。
- `cargo test --workspace`：全部通过。
- 前端原生解除部署门面：3/3 Vitest 通过。
- TypeScript 检查通过。
- ESLint（新增桌面端文件）通过。
- `cargo fmt --all` 通过。

## 安全边界

- 删除目标前必须通过物理身份和目录树哈希校验；外部修改不会被覆盖或删除。
- 集中库版本不随解除部署删除。
- 共享物理目标的关系选择由领域服务区分，`KeepSharedDeployment`/`RemoveRelationOnly` 不触碰目标文件。
- 集中库 Skill 删除、多目标删除向导、外部变化收集和独立副本转换不在本 Task。

## 待完成

- Windows/macOS 本地 CI 和真实 Agent 客户端验收尚未在本 Task 报告中收口。
