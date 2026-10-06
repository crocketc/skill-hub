# SkillHub 文档地图

本页是 `docs/` 的唯一入口地图：先按五层口径定位层，再进对应目录。接手开发按根 [AGENTS.md](../AGENTS.md) 执行；阅读顺序：产品规范索引（按任务）→ 开发状态 → 自动化测试说明 → 功能完成度与验收状态矩阵，需要真机验证时再读人工验收清单。

## 五层口径

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 1 业务层 | [product/业务决策模型.md](product/业务决策模型.md) | 五个业务模型（技能、关系治理、Skill 操作、安全分级与预警、冲突治理）的场景、后端闭环操作、前端操作、结果与边界；开发遇待决策事项先查这里 |
| 2 产品层 | [product/](product/README.md) 其余文件 | 产品规范索引、产品定位与模型边界、界面呈现与操作入口；产品行为与前后端交互的实施依据 |
| 3 开发层 | [development/](development/) | 四份当前快照 + archive/ 开发归档；当前进度、测试与真机验收的唯一汇总 |
| 4 项目整体规则层 | 仓库根 [AGENTS.md](../AGENTS.md)（不在 docs/ 内） | 通用开发规则、协作与安全约束、文档路由 |
| 5 归档层 | [archive/](archive/) 与 development/archive/ | 已实现过时、历史讨论、原始验收证据；只用于追溯，不作为接手入口，不在其中维护"当前状态" |

## 业务层与产品层（product/）

| 文档 | 用途 |
| --- | --- |
| [业务决策模型](product/业务决策模型.md) | 五个业务模型的权威裁决内容，自包含；先查模型总览表再进对应决策卡 |
| [产品规范索引](product/README.md) | 按任务路由到对应规范的产品文档入口 |
| [产品定位与模型边界](product/产品定位与模型边界.md) | 产品定位、实体身份、主体/关系职责与命名边界 |
| [界面呈现与操作入口](product/界面呈现与操作入口.md) | 前端展示、统一术语、图标、快捷抽屉/详情/列表操作分工与已确认样式 |

## 开发层（development/ 与根目录现行文件）

四份当前快照文件名固定为 2026-10-06，以正文标注的最新快照日期为准；历史原文归档，不作为接手入口。

| 文档 | 用途 |
| --- | --- |
| [开发状态](development/开发状态-2026-10-06.md) | 当前基线、仍需推进的功能工作、DEV/FB 追踪与实施顺序 |
| [自动化测试说明](development/自动化测试说明-2026-10-06.md) | 自动化命令、当前验证基线、覆盖范围与自动化不能替代的边界 |
| [人工验收清单](development/人工验收清单-2026-10-06.md) | 真实桌面逐项验收的唯一执行入口，按完整操作流程编排 |
| [功能完成度与验收状态矩阵](development/功能完成度与验收状态矩阵-2026-10-06.md) | 功能完成度、自动化／Windows／macOS 状态与发布阻塞项汇总 |

docs 根目录直接存放的现行流程与参考文档（其中前四项路径被发布/供应链脚本按字面引用，不得随意移动）：

| 文件 | 用途 |
| --- | --- |
| [发布流程](release-process.md) | Windows/macOS 早期发布流程；发布工作流以其为发布说明文件 |
| [发布检查清单](release-checklist.md) | 每个候选发布提交的检查清单；发布就绪脚本按路径校验 |
| [依赖与供应链策略](dependency-policy.md) | 依赖安装脚本审阅记录；生命周期检查脚本按路径读取 |
| [本地CI使用](本地CI使用.md) | 本地 CI 的环境与命令说明 |
| [Agent平台兼容性调研](Agent平台兼容性调研.md) | Agent 平台兼容性调研，后续随平台支持更新 |
| [Skill使用痛点与SkillHub解决方案](Skill使用痛点与SkillHub解决方案.md) | 产品痛点与方案定位，产品营销参考 |

[install/](install/)：Windows/macOS 未签名构建安装说明；发布就绪脚本按路径校验，随安装方式演进更新。

## 归档层（archive/ 与 development/archive/）

[archive/](archive/) 按主题组织，只用于追溯：

| 子目录 | 内容 |
| --- | --- |
| [archive/decisions/specs/](archive/decisions/specs/) | 历史裁决与设计讨论文档（原 docs/superpowers/specs） |
| [archive/decisions/plans/](archive/decisions/plans/) | 配套实施计划与交接指令（原 docs/superpowers/plans，含被取代的 plans/archive/） |
| [archive/requirements/](archive/requirements/) | 立项期需求文档、用户故事、产品与交互设计、技术架构设计与场景梳理材料 |
| [archive/llm/](archive/llm/) | LLM 供应商兼容矩阵、架构决策、用户配置与隐私说明及历史归档 |
| [archive/research/](archive/research/) | 调研资料（cc-switch 调研等） |
| [archive/architecture/](archive/architecture/) | 旧架构方案（已被产品规范与实施计划取代） |
| [archive/testing/](archive/testing/) | 原子测试目录（v0.2.0），历史编号与追踪关系 |

[development/archive/](development/archive/) 按日期主题存放旧当前快照、验收证据与交接指令，内部结构不再调整。`.superpowers/` 是本地实施进度台账（不入库），由开发快照按相对路径引用，不属于本文档体系。

## 新文档存放规则

- **新的产品裁决**：直接写入 product/ 对应规范——模型级裁决进[业务决策模型](product/业务决策模型.md)，界面/入口/文案类进[界面呈现与操作入口](product/界面呈现与操作入口.md)；不另建新文件。
- **讨论过程文档**：出生即放 `docs/archive/decisions/`（讨论稿进 specs/，配套实施计划进 plans/，命名 `<日期>-<主题>`）；讨论项不等于已确认规则，实施依据以 product/ 为准。
- **开发快照轮换**：沿用 development/ 现有规则——形成新的中文主题 + `YYYY-MM-DD` 快照、更新所有引用后，把旧当前文档移入 `development/archive/<日期>-<主题>/`。
- 归档目录只用于追溯，不在其中继续维护"当前状态"；不删除历史证据。
