# GOAL 交接指令：Windows 真机取证与用例数闭合（2026-09-18）

> 本文件是交给 **Windows 宿主代理** 的作业指令。读完立即开工，不要向用户确认范围或排期——已授权你自行裁决并在执行中调整。
> 唯一例外：涉及**用户主观观感**的事项，登记到《人工验收清单-2026-09-18》并采用可回滚默认实现，不阻塞、不提问。
> 核心原则：**证据先行**。你产出的每一行结论都必须来自你在 Windows 宿主上真实执行的命令与操作；拿不到证据就如实写「未取得」，不得把 macOS 的既有结论转写成 Windows 通过。

---

## 0. 背景（一段话）

`feat/v0.2.0-product-completion` 分支的代码与自动化已收口（macOS 基线：Rust 142 个测试目标 / 1096 通过、前端 165 文件 / 1773 用例、E2E 387、`ci-local` 10/10，见《自动化测试说明-2026-09-18》）。**全部剩余开放项都需要 Windows 宿主**，只有两件半：

1. Rust 用例数的跨平台差额闭合：macOS 实测 1096，平台门控推算 Windows 应为 **1100**，而上一轮独立复核在 Windows 报告 **1098**——有 2 个用例未归因；
2. RC-13/RC-14：无提升权限 Windows 账号下的 junction 转换、探针零残留、跨卷拒绝——自动化在 macOS 上无法编译 Windows 专属测试，从未取得真机证据；
3. （顺带）9 个 Windows 专属测试（8 个函数级 + 1 个模块级）此前从未在 Windows 上被单独确认过执行结果。

## 1. 开工位置（Windows 宿主准备）

```powershell
git clone git@github.com:crocketc/skill-hub.git   # 或进入已有 clone
git checkout feat/v0.2.0-product-completion
git pull --ff-only          # 起点必须是 origin 同步状态（截至本指令为 d8dc64b3 或更新）
git log --oneline -3
git status                  # 必须干净
```

- Rust 工具链：stable + MSVC target（`rustup default` 确认）；Node + pnpm 可用（P1 需要）。
- junction 创建**不需要**提权；符号链接需要开发者模式或管理员——这正是 RC-13 要测的边界，**不要**用管理员账号跑 RC-13。
- bash 语法的命令（`grep`、`2>/dev/null`）请在 **Git Bash** 中执行；下文同时给 PowerShell 等价形式。
- **不要**新建 worktree；**不要** force-push；完成一项提交一项，推同一分支。

## 2. 任务

### P0-A Rust 用例数闭合（最优先，成本最低、结论最硬）

两条命令都要跑，**分别记录**（列表数与全量通过数可能不一致，这正是要查的）：

```bash
# Git Bash
cargo test --workspace --all-features -- --list 2>/dev/null | grep -c ': test$'
cargo test --workspace --all-features 2>&1 | tail -5
```

```powershell
# PowerShell 等价
cargo test --workspace --all-features -- --list 2>$null | Select-String ': test$' | Measure-Object -Line
cargo test --workspace --all-features
```

判定与闭环：

- 平台门控推算 Windows 应为 **1100**（macOS 1096 − Unix 专属 5 + Windows 专属 8 + Windows 专属模块 1）。
- **若列表数 = 1100 且全量通过 = 1100**：差额是上一轮复核那次运行的环境问题。在《开发状态-2026-09-18》「仍需」第 2 条与《功能完成度与验收状态矩阵-2026-09-18》阻塞项 4 写入实测数字即闭合。
- **若列表数 = 1098（或其他）**：说明有用例被静默排除，**必须定点到具体用例名**。方法：把 `--list` 完整输出存到仓库外文件，核对下表 9 个 Windows 专属用例是否全部在列表里；再用全量输出核对 `test result` 行的通过数与列表数是否一致：

| 期望在 Windows 列表中的用例 | 位置 |
|---|---|
| Windows 专属 `#[test]` ×8 | `src-tauri/src/updater.rs` 1、`adapters/tests/discovery.rs` 1、`adapters/tests/watcher.rs` 1、`adapters/tests/deployment_filesystem.rs` 3、`core/tests/path_policy.rs` 1、`core/tests/external_change_hint.rs` 1 |
| Windows 专属模块 ×1 | `adapters/src/deployment/junction_windows.rs` → `creates_a_mount_point_with_the_raw_windows_api` |

  另核对 5 个 Unix 专属用例**不在**列表（`storage/tests/projects.rs` 1、`adapters/tests/discovery.rs` 1、`adapters/tests/scanner.rs` 1、`adapters/tests/deployment_filesystem.rs` 1、`core/tests/deployment_planner.rs` 1）。
- 若发现某个 Windows 专属用例真的没被编译/执行（cfg 写错、特性门控、夹具前置失败等），这是**真实缺陷**：按 TDD 修（先写能复现的失败测试），修复提交单独、信息英文动词开头；不要顺手重构。
- 测试基线纪律：**测试数只增不减**；不得删用例、降断言、加任意延时。

### P0-B RC-13 / RC-14 junction 真机取证（发布阻塞项）

严格按《人工验收清单-2026-09-18》的 RC-13 / RC-14 两行执行，并按该文件「验收记录格式」回填（日期、系统版本、构建版本、前置条件、操作步骤、观察结果、日志索引、结论）：

- **RC-13**：在**无提升权限**（非管理员、建议不开开发者模式）的 Windows 账号下，对一个真实 Skill 副本执行「纳入集中库管理」的 junction 转换。预期：产品按能力探测选择 junction；失败时有明确原因文案（不得出现 `[object Object]`）；**用户原文件零误删**。
- **RC-14**：junction 探针零残留；源目录更新后可移除；跨卷场景按规则拒绝。
- 同时记录首次真实执行的 9 个 Windows 专属测试所在套件是否有失败（P0-A 全量输出即可覆盖，但请在记录里点名）。
- 失败证据照样有价值：保留可复现步骤与日志索引，**不要**为了转绿改断言或加等待。
- 记录里只允许匿名化的临时目录形态（如 `%TEMP%\skillhub-rc13-…`），**不得**出现真实用户路径、账号名、密钥。

### P1 Windows 首次前端电池（首次取证，成本约 10 分钟）

前端全量从未在 Windows 上记录过。在仓库根执行并记录：

```powershell
pnpm install --frozen-lockfile
pnpm --dir apps/desktop test --run     # 期望 165 文件 / 1773 用例
pnpm --dir apps/desktop check          # ESLint --max-warnings 0 + tsc
node scripts/i18n-cjk-audit.mjs        # user-visible 0 条
```

- 若因路径分隔符、大小写或换行出现失败：这是**真实的跨平台缺陷**，逐条登记（文件 + 用例名 + 失败摘要），不要在 Windows 上「顺手修平台判断」之外扩大范围；修复走 TDD、独立提交。
- 数量基线：**只增不减**。

### P2（可选，仅当这台 Windows 是真实桌面）其余人工验收项

若环境带真实桌面会话，可继续执行《人工验收清单-2026-09-18》的 J-REL-1—4（窄视口）、SR-1—7（统一执行反馈：取消/恢复/通知深链）、SR-8（动作词）、SR-10（失败文案可读性），逐项回填记录。没有桌面会话（如远程 CI 容器）就跳过本节，如实登记「环境不具备」。

### P3（可选）E2E

非阻塞。若跑：确认 **5174 端口空闲**（配置 `reuseExistingServer=false` + `strictPort`），日志写仓库外，判定看逐条 `ok`/`not ok` 计数而非汇总行；Windows 上若复现「全部 ok 后进程不退出」，记录现象与残留进程名即可，**不要**为它改断言或加延时。

## 3. 结果回写（文档同步，硬性要求）

- 《人工验收清单-2026-09-18》：RC-13/RC-14 行填入验收记录（含日志索引）；做了 P2 则对应行同步。
- 《功能完成度与验收状态矩阵-2026-09-18》：RC-13/14 相关行与阻塞项 4 按实测更新。
- 《开发状态-2026-09-18》：「仍需」第 2 条按实测闭合或定点结果更新。
- 更新引用时注意：当前快照是 **-2026-09-18** 四件套；归档目录只用于追溯，不要在其中维护当前状态。

## 4. 硬约束（来自 AGENTS.md 与既有裁决，不得违反）

- 行为变更必须 TDD：先写失败测试再实现；**严禁**降断言、删用例、加任意延时、静默 `return`。
- `apps/desktop/src/api/bindings.ts` 只由生成器更新；正确口径是「生成前后 SHA256 一致 + 再生成一次为不动点」，**不是** `git diff --exit-code`。
- 术语冻结：动词用「添加到 Agent/项目」「从 Agent/项目移除」，技术名词保留「部署/解除部署」「符号链接/目录联接/受管复制」；不得用「装配」「安装/卸载」。
- 中英双语文案键集对称（`zh-CN/common.json` 与 `en-US/common.json` 同步改）。
- 不提交个人绝对路径、真实 Skill 内容、密钥、缓存、构建产物；`git diff --check` 通过后再提交。
- 提交信息：英文、动词开头、一项一提交；推送到 `feat/v0.2.0-product-completion`，**不 force-push**。

## 5. 阅读顺序

1. 本文件
2. `docs/development/开发状态-2026-09-18.md`
3. `docs/development/自动化测试说明-2026-09-18.md`（用例数归因细节、能力守卫、环境提醒）
4. `docs/development/功能完成度与验收状态矩阵-2026-09-18.md`
5. 真机操作时：`docs/development/人工验收清单-2026-09-18.md`
6. 历史推导（仅追溯，不要从中恢复结论）：`docs/development/archive/2026-09-18-六轮更新后快照/`

## 6. 完成定义与报告

完成 = P0-A 有实测数字并闭合（或定点到用例名）+ P0-B 有逐项验收记录 + 第 3 节文档回写 + 全部提交已推送。收工时报告：修改的文件、每条验证命令与结果原文摘要、提交哈希列表、未解决问题与后续依赖。 macOS 侧遗留的 E2E 收尾卡死排查不在本指令范围。
