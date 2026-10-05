# SkillHub 项目文档索引

本页是 `docs/` 的路由入口，只维护指向，不在索引中复制状态或裁决。接手开发按根 [AGENTS.md](../AGENTS.md) 的文档路由执行；当前开发入口的阅读顺序为「开发状态 → 自动化测试说明 → 功能完成度与验收状态矩阵」，需要真机验证时再读「人工验收清单」。

## 当前开发入口（development/）

四份当前文档文件名固定为 2026-09-30，以正文标注的最新快照日期为准；历史原文按日期归档，不作为接手入口。

| 文档 | 用途 |
| --- | --- |
| [开发状态](development/开发状态-2026-10-05.md) | 当前基线、仍需推进的功能工作、DEV/FB 追踪与实施顺序 |
| [自动化测试说明](development/自动化测试说明-2026-10-05.md) | 自动化命令、当前验证基线、覆盖范围与自动化不能替代的边界 |
| [人工验收清单](development/人工验收清单-2026-10-05.md) | 真实桌面逐项验收的唯一执行入口，按完整操作流程编排 |
| [功能完成度与验收状态矩阵](development/功能完成度与验收状态矩阵-2026-10-05.md) | 功能完成度、自动化／Windows／macOS 状态与发布阻塞项汇总 |

历史快照与验收证据归档：[development/archive/](development/archive/)（各日期主题目录；实施准备前完整快照见 [2026-10-04-实施准备前快照](development/archive/2026-10-04-实施准备前快照/README.md)）。

## 实施计划与交接（superpowers/plans/）

- [技能功能缺口补全实施计划（2026-10-04）](superpowers/plans/2026-10-04-技能功能缺口补全实施计划.md)：下一轮实施入口，K0—K10 工作包、执行组织与完成标准。
- [技能功能补全团队交接指令（2026-10-04）](superpowers/plans/2026-10-04-技能功能补全团队交接指令.md)：可直接交给下一轮主代理的执行交接。
- [后续实施交接指令（2026-10-04）](superpowers/plans/2026-10-04-技能功能补全后续实施交接指令.md)：本轮接手进度与 A/B 首批 RED 分工。
- [K0 契约与故障矩阵（2026-10-04）](superpowers/plans/2026-10-04-K0契约与故障矩阵.md)：真实生产缺口、预览／执行／恢复契约、实施裁决和故障覆盖依据。
- [关系治理增量实施计划（2026-10-03）](superpowers/plans/2026-10-03-relationship-governance-incremental-implementation-plan.md)：仍有效的关系治理增量计划。
- 被后续实施取代的旧计划归档于 [plans/archive/](superpowers/plans/archive/)，只用于追溯。

## 链路审查与规范讨论（superpowers/specs/）

- 2026-10-04 静态链路审查（生产缺口依据，均已纳入实施计划）：[抽屉详情技能链路](superpowers/specs/2026-10-04-抽屉详情技能链路审查.md)、[内容版本安全链路](superpowers/specs/2026-10-04-内容版本安全链路审查.md)、[画像来源导航链路](superpowers/specs/2026-10-04-画像来源导航链路审查.md)、[治理派发导出删除链路](superpowers/specs/2026-10-04-治理派发导出删除链路审查.md)。
- 更早的产品裁决与设计讨论按文件名日期查阅同目录。

## 产品规范（product/）

产品行为与前后端交互的实施依据：[产品规范索引](product/README.md)、[产品定位与模型边界](product/产品定位与模型边界.md)、[界面呈现与操作入口](product/界面呈现与操作入口.md)。具体模块规则从索引进入，不在本索引复制。

## 专题目录

| 目录 | 内容 |
| --- | --- |
| [architecture/](architecture/) | 架构资料；现行架构裁决以产品规范与实施计划为准，旧方案在 [architecture/archive/](architecture/archive/) |
| [install/](install/) | Windows／macOS 未签名构建安装说明 |
| [llm/](llm/) | LLM 供应商兼容矩阵、架构决策与用户配置隐私说明；历史归档在 llm/archive/ |
| [research/](research/) | 调研资料；归档在 research/archive/ |
| [testing/](testing/) | 原子测试目录（v0.2.0）说明 |

## 根级资料

[需求文档](需求文档.md)、[产品与交互设计](产品与交互设计.md)、[技术架构设计](技术架构设计.md)、[用户故事](用户故事.md)、[Agent平台兼容性调研](Agent平台兼容性调研.md)、[Skill使用痛点与SkillHub解决方案](Skill使用痛点与SkillHub解决方案.md)、[本地CI使用](本地CI使用.md)、[发布流程](release-process.md)、[发布检查清单](release-checklist.md)、[依赖策略](dependency-policy.md)。

## 归档规则

归档目录只用于追溯历史待办、验收证据与被取代计划，不作为当前接手入口，也不在其中继续维护"当前状态"。形成新当前快照时的移动与命名规则见根 [AGENTS.md](../AGENTS.md)。
