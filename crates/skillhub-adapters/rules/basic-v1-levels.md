# basic-v1 规则产品级定级表（W3-1 / FB-003，2026-10-05 裁决收口）

行为依据：[未决事项产品裁决](../../../docs/superpowers/specs/2026-10-05-未决事项产品裁决.md) 第 1 节；操作模型规范 §23。
分级只基于确定性规则，AI 仅辅助解释、不参与任何分级或放行判定。`severity` 字段保留（兼容既有存储与查询）；`product_level` 是叠加的产品字段，两者独立维护，改动任一侧都须同步本表并跑 `basic_security.rs` 的映射对照测试。

## 定级映射（12 条逐条复核）

主映射规则：critical/error 类确定性规则 → **danger**（危险级：导入时必须由用户对该 Skill 显式决策"仍要导入／不导入"）；warning 类 → **warning**（警告级：直接导入并写入预警）。放行级＝无发现，不是规则属性。逐条复核后全部按主映射定级，无升/降级例外；逐条依据如下。

| # | 规则 code | severity | product_level | 定级依据（内容复核） |
| --- | --- | --- | --- | --- |
| 1 | `security.destructive_command` | critical | **danger** | `rm -rf`／`mkfs`／`del /f` 等无差别删除命令，误执行即不可逆破坏用户数据；必须由用户知情决策。 |
| 2 | `security.elevation` | error | **danger** | `sudo`／`runas` 等提权执行，影响超出 Skill 自身范围且可静默改写系统状态。 |
| 3 | `security.permission_change` | error | **danger** | `chmod`／`chown`／`icacls` 修改属主与 ACL，影响持久且波及 Skill 目录之外。 |
| 4 | `security.persistence` | error | **danger** | `crontab`／LaunchAgents／计划任务等自启动驻留，跨会话存活、用户难以察觉，属典型持久化手法。 |
| 5 | `security.download_and_execute` | critical | **danger** | 下载内容直接管道执行（`curl … \| bash`／`iex`），等于把执行权交给远端内容，是最高风险的远程代码执行路径。 |
| 6 | `security.data_upload` | error | **danger** | 带 payload 的上传命令（`curl -d/--form` 等）构成数据外发通道；示例行已由扫描豁免，命中即真实上传语句。 |
| 7 | `security.command_interpolation` | warning | **warning** | `eval`／`$()` 属健壮性/注入面提示；被插值内容就在文件内，确定性的危险命令规则已独立覆盖，本条单独不构成危险证据。 |
| 8 | `security.obfuscation` | warning | **warning** | `base64 -d`、零宽/双向控制字符常见于合法文档与 Unicode 排版；可疑但非危害证据，需人工判读。 |
| 9 | `security.path_traversal` | error | **danger** | 见下方复核注记：触发内容有误报面，但按 §23 error 类归危险级；真实穿越尝试（配合读取/写入命令）足以支撑用户显式决策门槛。 |
| 10 | `security.possible_plaintext_credential` | warning | **warning** | 疑似明文凭据（凭据值已脱敏）；常见于示例与文档，泄露后果取决于文件流转，交由预警提示而非导入阻断。 |
| 11 | `security.prompt_injection` | warning | **warning** | 提示注入话术影响 Agent 行为，不直接危害系统；确定性命中多见文档引述，警告级＋预警合适。 |
| 12 | `security.suspicious_external_resource` | warning | **warning** | `<script`／`javascript:`／外链图片等可疑外链资源；加载行为取决于运行环境，单独不构成危险动作。 |

## 复核注记

- **path_traversal（#9）**：检测子串 `../`／`..\`／`%2e%2e` 在合法 Markdown 相对链接与路径示例中高频出现，是规则集内已知的误报面候选（回归素材见 `fixtures/skills/security/`）。本次复核结论：保持 §23 的 error→danger 主映射不变（该规则同时覆盖真实路径穿越写法，降级会让真实攻击面只得到警告），误报治理走扫描规则的豁免/素材路线，不在产品级映射里开例外。导入体验上，危险级命中走"展示明细＋用户显式决策"，不硬拦。
- 其余 11 条复核均无内容与级别错配：无"纯风格类内容误配 error"的规则（7/8/10/11/12 本就是 warning）；warning 类中也无需要升为危险级的规则（均不直接执行破坏性动作）。

## 变更纪律

- 新增/调整规则必须同步：本表、`basic-v1.json` 的 `product_level`、`basic_security.rs` 的映射对照测试；漏改任一会被判据测试拦下。
- 改检测逻辑（误报治理）不改产品级映射；改产品级映射必须先改裁决/规范文档并在此注明依据。
