import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const storiesPath = path.join(repositoryRoot, "docs", "用户故事.md");
const outputPath = path.join(repositoryRoot, "docs", "testing", "原子测试目录-v0.2.0.md");

const source = await readFile(storiesPath, "utf8");
const lines = source.split(/\r?\n/);

function clean(value) {
  return value
    .replace(/^\-\s+/, "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBranch(raw, title) {
  const text = clean(raw);
  let match = text.match(/^Given (.+?)[，,]When (.+?)[，,]Then (.+)$/);
  if (match) {
    return { precondition: match[1], action: match[2], expected: match[3] };
  }
  match = text.match(/^Given (.+?)[，,]Then (.+)$/);
  if (match) {
    return {
      precondition: match[1],
      action: `触发“${title}”对应处理`,
      expected: match[2],
    };
  }
  match = text.match(/^Before (.+?)[，,]Then (.+)$/);
  if (match) {
    return {
      precondition: `即将${match[1]}`,
      action: "查看并确认执行前信息",
      expected: match[2],
    };
  }
  match = text.match(/^After (.+?)[，,]Then (.+)$/);
  if (match) {
    return {
      precondition: `已${match[1]}`,
      action: "查看操作完成后的状态",
      expected: match[2],
    };
  }
  match = text.match(/^Then (.+)$/);
  if (match) {
    return {
      precondition: `已进入“${title}”对应功能且测试数据已准备`,
      action: "查看当前界面、查询结果或操作摘要",
      expected: match[1],
    };
  }
  match = text.match(/^(.+?)(?:则|时)(.+)$/);
  if (match) {
    return {
      precondition: match[1],
      action: `触发“${title}”对应处理`,
      expected: match[2],
    };
  }
  return {
    precondition: `已进入“${title}”对应功能且测试数据已准备`,
    action: "执行该验收分支",
    expected: text,
  };
}

function versionFor(storyId) {
  if (storyId === "US-046" || storyId === "US-047") return "下一版本";
  if (storyId === "US-060") return "v0.2.0（仅边界说明）";
  return "v0.2.0";
}

const stories = [];
for (let index = 0; index < lines.length; index += 1) {
  const heading = lines[index].match(/^### (US-\d{3}) (.+)$/);
  if (!heading) continue;
  const [, id, title] = heading;
  const acceptance = [];
  let inAcceptance = false;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (/^### US-\d{3} /.test(lines[cursor]) || /^## \d+\./.test(lines[cursor])) break;
    if (lines[cursor] === "**验收标准：**") {
      inAcceptance = true;
      continue;
    }
    if (lines[cursor].startsWith("**来源：**")) break;
    if (inAcceptance && lines[cursor].startsWith("- ")) acceptance.push(lines[cursor]);
  }
  stories.push({ id, title, acceptance });
}

const globalRules = [];
let inGlobalRules = false;
for (const line of lines) {
  if (line === "## 3. 全局验收规则") {
    inGlobalRules = true;
    continue;
  }
  if (inGlobalRules && line.startsWith("## ")) break;
  const match = inGlobalRules ? line.match(/^(\d+)\. (.+)$/) : null;
  if (match) globalRules.push({ number: Number(match[1]), text: match[2] });
}

if (stories.length !== 62) {
  throw new Error(`Expected 62 user stories, found ${stories.length}`);
}
if (stories.some((story) => story.acceptance.length === 0)) {
  throw new Error(`Stories without acceptance criteria: ${stories.filter((story) => story.acceptance.length === 0).map((story) => story.id).join(", ")}`);
}
if (globalRules.length !== 10) {
  throw new Error(`Expected 10 global rules, found ${globalRules.length}`);
}

const rows = [];
for (const story of stories) {
  const branches = story.acceptance.flatMap((criterion) =>
    clean(criterion)
      .split(/；|。(?=(?:Given|When|Then|Before|After)\s)/)
      .map((branch) => branch.trim())
      .filter(Boolean),
  );
  branches.forEach((criterion, criterionIndex) => {
    const parsed = parseBranch(criterion, story.title);
    const caseNumber = String(criterionIndex + 1).padStart(2, "0");
    const future = versionFor(story.id) === "下一版本";
    rows.push({
      id: `TC-${story.id.replace("-", "")}-${caseNumber}`,
      story: `${story.id} ${story.title}`,
      version: versionFor(story.id),
      ...parsed,
      type: "自动化",
      automation: future ? "非 v0.2.0 范围；待下一版本建立证据" : "待反向索引；缺失时先补失败测试",
      result: future ? "不适用（v0.2.0）" : "未执行",
      evidence: "—",
    });
  });
}

rows.push(
  {
    id: "TC-US001-06",
    story: "US-001 初始化集中库",
    version: "v0.2.0",
    precondition: "已通过原生目录选择器选择一个自定义集中库路径",
    action: "再次点击选择其他目录并确认另一路径",
    expected: "目录选择器保持可用，界面以第二次选择的路径替换第一次路径",
    type: "自动化",
    automation: "apps/desktop/src/features/onboarding/LibraryStep.test.tsx：keeps the native directory picker available after a custom directory is chosen",
    result: "通过",
    evidence: "QA-002",
  },
  {
    id: "TC-US001-07",
    story: "US-001 初始化集中库",
    version: "v0.2.0",
    precondition: "自定义集中库路径已保存但应用重启失败",
    action: "重新选择另一个目录并再次保存",
    expected: "新路径替换旧路径并提交给集中库设置命令，初始化不会被误报为完成",
    type: "自动化",
    automation: "apps/desktop/src/features/onboarding/OnboardingWizard.test.tsx：allows choosing another custom library path after restart fails",
    result: "通过",
    evidence: "QA-002",
  },
  {
    id: "TC-US015-07",
    story: "US-015 从多种来源安全获取 Skill",
    version: "v0.2.0",
    precondition: "已选中多个扫描来源",
    action: "通过原生目录选择器再选择一个本地目录",
    expected: "新目录追加到当前选择，已有扫描来源保持不变",
    type: "自动化",
    automation: "apps/desktop/src/features/import/ImportWizard.test.tsx：adds a directory from the native picker without clearing selected scan sources",
    result: "通过",
    evidence: "QA-003",
  },
  {
    id: "TC-US015-08",
    story: "US-015 从多种来源安全获取 Skill",
    version: "v0.2.0",
    precondition: "全部扫描来源已选中",
    action: "点击批量选择动作",
    expected: "动作变为全不选并取消扫描来源，手动添加的来源保留",
    type: "自动化",
    automation: "apps/desktop/src/features/import/SourceInput.test.tsx：offers a clear-all action when every scanned source is selected",
    result: "通过",
    evidence: "QA-004",
  },
  {
    id: "TC-US015-09",
    story: "US-015 从多种来源安全获取 Skill",
    version: "v0.2.0",
    precondition: "已解析一个本地路径来源",
    action: "查看来源描述区域",
    expected: "本地路径不再重复显示类型/目标描述块，URL、Git 等非本地来源仍保留描述块",
    type: "自动化",
    automation: "apps/desktop/src/features/import/SourceInput.test.tsx：does not repeat a parsed local path in a descriptor block；keeps the descriptor block for non-local sources",
    result: "通过",
    evidence: "QA-004",
  },
  {
    id: "TC-US015-10",
    story: "US-015 从多种来源安全获取 Skill",
    version: "v0.2.0",
    precondition: "候选门槛页已获取多个来源的候选项",
    action: "点击移除全部来源",
    expected: "一次回到来源选择状态，不再保留已获取候选和继续按钮",
    type: "自动化",
    automation: "apps/desktop/src/features/import/ImportWizard.test.tsx：removes all acquired sources from the candidate gate in one action",
    result: "通过",
    evidence: "QA-004",
  },
  {
    id: "TC-US016-06",
    story: "US-016 通过统一流程导入 Skill",
    version: "v0.2.0",
    precondition: "导入已完成且结果包含成功、跳过和失败",
    action: "查看导入结果页",
    expected: "先显示成功、跳过、失败数量，默认只展开失败项，成功和跳过明细需显式展开",
    type: "自动化",
    automation: "apps/desktop/src/features/import/ImportSummary.test.tsx：summarizes all outcomes and expands successful details only on request",
    result: "通过",
    evidence: "QA-005",
  },
  {
    id: "TC-US005-05",
    story: "US-005 查看可下钻的概览",
    version: "v0.2.0",
    precondition: "导入结果中存在成功项",
    action: "在发现路由完成导入",
    expected: "路由失效技能列表查询并刷新启动快照，概览统计反映导入后的数量，应用外壳不重新挂载",
    type: "自动化",
    automation: "apps/desktop/src/app/DiscoveryRoute.test.tsx：refreshes the shared bootstrap snapshot after an import with a succeeded result；apps/desktop/src/features/bootstrap/BootstrapGate.test.tsx：refreshes the shared bootstrap snapshot without remounting the shell",
    result: "通过",
    evidence: "QA-006",
  },
  {
    id: "TC-US005-06",
    story: "US-005 查看可下钻的概览",
    version: "v0.2.0",
    precondition: "导入结果全部失败",
    action: "在发现路由完成导入",
    expected: "不刷新启动快照，也不失效技能列表查询",
    type: "自动化",
    automation: "apps/desktop/src/app/DiscoveryRoute.test.tsx：does not refresh the bootstrap snapshot when every import result failed",
    result: "通过",
    evidence: "QA-006",
  },
  {
    id: "TC-US039-06",
    story: "US-039 重命名或重新关联来源",
    version: "v0.2.0",
    precondition: "快速抽屉中编辑某 Skill 的显示别名或备注",
    action: "提交编辑",
    expected: "编辑通过原生 set_metadata 持久化；显示别名映射 display_name 且保留标签、作者、许可证；成功后快速视图与技能库列表查询失效并重新读取",
    type: "自动化",
    automation: "apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx：refetches the persisted quick view and library list after a metadata save succeeds；apps/desktop/src/features/skills/nativeApi.test.ts：merges an alias patch into the full metadata contract without dropping fields",
    result: "通过",
    evidence: "QA-007",
  },
  {
    id: "TC-US039-07",
    story: "US-039 重命名或重新关联来源",
    version: "v0.2.0",
    precondition: "元数据保存失败或门面未接入保存能力",
    action: "提交抽屉中的别名或备注编辑",
    expected: "抽屉显示保存失败告警，乐观更新回滚为已持久化的值，不静默丢弃编辑",
    type: "自动化",
    automation: "apps/desktop/src/features/skills/SkillQuickDrawer.test.tsx：shows a save failure and restores the persisted value when saving metadata fails；reports a failure instead of silently dropping edits when the facade cannot save metadata",
    result: "通过",
    evidence: "QA-007",
  },
  {
    id: "TC-US039-08",
    story: "US-039 重命名或重新关联来源",
    version: "v0.2.0",
    precondition: "完整详情页编辑别名、用途说明、标签或备注",
    action: "保存元数据修改",
    expected: "编辑经原生 set_metadata 全量契约持久化；用途说明写入领域独立 user_purpose 字段而非译文；未修改的标签、作者、许可证保持不变",
    type: "自动化",
    automation: "apps/desktop/src/features/skill-detail/nativeApi.test.ts：saves metadata patches through the full overwrite contract without dropping fields；maps the native skill projection to summary and metadata",
    result: "通过",
    evidence: "QA-008",
  },
  {
    id: "TC-US035-04",
    story: "US-035 查看版本历史与差异",
    version: "v0.2.0",
    precondition: "本地导入形成首个捕获版本，无用户命名标签",
    action: "查询 Skill 详情与快速抽屉的当前版本",
    expected: "当前版本展示按捕获顺序推导的 v1 序号；内容哈希只作为技术身份保留在 current_version，不进入展示标签",
    type: "自动化",
    automation: "crates/skillhub-application/tests/facade.rs：get_skill_exposes_capture_sequence_as_current_version_label；apps/desktop/src/features/skills/nativeApi.quickView.test.ts：enriches the quick view with real check states, versions and deployment relations",
    result: "通过",
    evidence: "QA-010",
  },
  {
    id: "TC-US035-05",
    story: "US-035 查看版本历史与差异",
    version: "v0.2.0",
    precondition: "用户已通过 set_version_label 命名当前版本",
    action: "查询 Skill 详情的当前版本标签",
    expected: "用户命名标签优先于 vN 捕获序号显示",
    type: "自动化",
    automation: "crates/skillhub-application/tests/facade.rs：named_version_label_takes_priority_over_capture_sequence",
    result: "通过",
    evidence: "QA-010",
  },
  {
    id: "TC-US016-07",
    story: "US-016 通过统一流程导入 Skill",
    version: "v0.2.0",
    precondition: "候选目录的 SKILL.md 头部含 description 字段",
    action: "完成本地导入",
    expected: "头部 description 进入目录 original_description，详情与快速抽屉的原始说明据此显示",
    type: "自动化",
    automation: "crates/skillhub-application/tests/facade.rs：commit_import_reads_frontmatter_description_into_the_catalog",
    result: "通过",
    evidence: "QA-009",
  },
);

globalRules.forEach((rule) => {
  rows.push({
    id: `TC-GR-${String(rule.number).padStart(2, "0")}`,
    story: `GR-${String(rule.number).padStart(2, "0")} 全局验收规则`,
    version: "v0.2.0",
    precondition: "执行任一受该全局规则约束的功能",
    action: "执行对应成功、失败、取消、重复、恢复或受限分支",
    expected: clean(rule.text),
    type: "自动化",
    automation: "待反向索引；缺失时先补失败测试",
    result: "未执行",
    evidence: "—",
  });
});

const manualCases = [
  ["TC-US001-M01", "US-001 初始化集中库", "Windows 或 macOS 首次启动且集中库尚未确认", "打开原生目录选择器后取消", "向导保持可操作且不写入集中库路径或内容", "QA-002"],
  ["TC-US001-M02", "US-001 初始化集中库", "Windows 或 macOS 首次启动且有测试专用空目录", "通过原生目录选择器确认自定义目录", "向导显示所选真实路径并允许继续初始化", "QA-002"],
  ["TC-US045-M01", "US-045 安全处理 Skill 中的凭证", "系统安全凭据存储可用", "保存测试专用占位凭据", "凭据仅进入系统安全存储，不进入集中库、备份或日志", "—"],
  ["TC-US045-M02", "US-045 安全处理 Skill 中的凭证", "系统安全凭据存储中存在测试专用占位凭据", "清除该测试凭据", "凭据被移除且其他应用凭据不受影响", "—"],
  ["TC-US053-M01", "US-053 创建完整备份并跨设备恢复", "Windows 测试库和 macOS 测试设备可用", "在 Windows 创建备份并在 macOS 恢复", "内容与逻辑关系恢复，Windows 绝对部署路径不沿用", "—"],
  ["TC-US053-M02", "US-053 创建完整备份并跨设备恢复", "macOS 测试库和 Windows 测试设备可用", "在 macOS 创建备份并在 Windows 恢复", "内容与逻辑关系恢复，macOS 绝对部署路径不沿用", "—"],
  ["TC-US056-M01", "US-056 退出管理或卸载前安全处理", "Windows 已安装且存在测试专用集中库", "使用系统卸载入口卸载应用", "应用被卸载，集中库和管理数据仍保留", "—"],
  ["TC-US056-M02", "US-056 退出管理或卸载前安全处理", "macOS 已安装且存在测试专用集中库", "移除应用后重新安装", "集中库保持不变且可重新关联", "—"],
  ["TC-US059-M01", "US-059 获取诚实的桌面应用更新提示", "Windows 未签名发布包可用", "安装并首次启动发布包", "SmartScreen（信誉保护）表现与未签名说明一致，不引导关闭安全能力", "—"],
  ["TC-US059-M02", "US-059 获取诚实的桌面应用更新提示", "Windows 未签名发布包和正式 Release 可用", "在应用内检查更新", "只提示版本并打开正式 Release，显示 SHA-256 和手动更新方式", "—"],
  ["TC-US059-M03", "US-059 获取诚实的桌面应用更新提示", "macOS ad-hoc 且未公证发布包可用", "安装并首次启动发布包", "Gatekeeper（门禁）表现与未公证说明一致", "—"],
  ["TC-US059-M04", "US-059 获取诚实的桌面应用更新提示", "macOS ad-hoc 且未公证发布包和正式 Release 可用", "在应用内检查更新", "只提示版本并打开正式 Release，不宣称无感自动更新", "—"],
  ["TC-GR-08-M01", "GR-08 全局验收规则", "Windows 测试设备和测试专用只读目录可用", "从只读目录执行导入或写入预检", "权限事实被准确显示，失败可恢复且目录内容不变", "—"],
  ["TC-GR-08-M02", "GR-08 全局验收规则", "macOS 测试设备和测试专用只读目录可用", "从只读目录执行导入或写入预检", "权限事实被准确显示，失败可恢复且目录内容不变", "—"],
  ["TC-GR-08-M03", "GR-08 全局验收规则", "Windows 测试设备存在测试专用目录联接或符号链接", "扫描并处理该链接指向的 Skill", "实体不被重复识别，链接和所有权事实准确且非自有内容不被覆盖", "—"],
  ["TC-GR-08-M04", "GR-08 全局验收规则", "macOS 测试设备存在测试专用符号链接", "扫描并处理该链接指向的 Skill", "实体不被重复识别，链接和所有权事实准确且非自有内容不被覆盖", "—"],
  ["TC-GR-09-M01", "GR-09 全局验收规则", "系统缩放比例可调整", "在常用缩放比例检查核心页面", "关键内容和操作无重叠、遮挡或不可达", "QA-011、QA-012"],
  ["TC-GR-09-M02", "GR-09 全局验收规则", "系统减少动态效果已开启", "浏览核心页面并执行状态切换", "非必要动画被弱化且状态反馈仍清晰", "—"],
  ["TC-GR-09-M03", "GR-09 全局验收规则", "简体中文和英文系统环境可切换", "切换界面语言并检查核心流程", "关键文案可理解且不截断操作含义", "—"],
  ["TC-GR-09-M04", "GR-09 全局验收规则", "真实桌面窗口中存在已支持 Agent", "查看 Agent 列表、详情和部署目标", "品牌图标与 Agent 身份一致，未知品牌使用明确回退", "QA-014"],
  ["TC-GR-09-M05", "GR-09 全局验收规则", "Windows 或 macOS 原生窗口可调整", "缩放窗口至支持的最小尺寸", "核心操作可达，窗口内容不发生永久遮挡", "QA-011、QA-012"],
];

for (const [id, story, precondition, action, expected, evidence] of manualCases) {
  rows.push({
    id,
    story,
    version: "v0.2.0",
    precondition,
    action,
    expected,
    type: "人工-真实设备",
    automation: "自动化不能替代真实系统证据",
    result: "未执行",
    evidence,
  });
}

const counts = rows.reduce((summary, row) => {
  summary[row.type] = (summary[row.type] ?? 0) + 1;
  return summary;
}, {});

const tableRows = rows.map((row) =>
  `| ${row.id} | ${row.story} | ${row.version} | ${row.precondition} | ${row.action} | ${row.expected} | ${row.type} | ${row.automation} | ${row.result} | ${row.evidence} |`,
);

const document = `# 原子测试目录（v0.2.0）

更新时间：2026-09-09

需求来源：《用户故事》US-001～US-062 及 10 条全局验收规则

生成命令：\`node scripts/generate_atomic_test_catalog.mjs\`

## 使用规则

- 本目录覆盖完整需求；只有版本归属为 v0.2.0 的用例进入当前发布门禁。
- 一行只描述一个操作闭环或分支。发现同一行仍含独立分支时，应先拆号再补证据。
- “待反向索引”不代表缺少测试；必须检查测试真实断言后才能填写证据。
- 自动化可覆盖的缺口必须先写失败测试。人工用例只保留真实系统、真实设备或视觉判断无法替代的项目。
- 执行结果只允许：未执行、通过、失败、阻塞、不适用（v0.2.0）。失败或阻塞必须填写问题编号和证据。

## 当前统计

- 用户故事：62/62
- 全局规则：10/10
- 自动化候选：${counts["自动化"] ?? 0}
- 人工真实设备：${counts["人工-真实设备"] ?? 0}
- 总计：${rows.length}

## 用例

| 编号 | 对应用户故事/规则 | 版本归属 | 前置条件 | 单一操作闭环或分支 | 明确可观察的预期结果 | 测试类型 | 自动化证据或缺失状态 | 执行结果 | 证据和问题编号 |
|---|---|---|---|---|---|---|---|---|---|
${tableRows.join("\n")}
`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, document, "utf8");
console.log(`Wrote ${rows.length} cases to ${path.relative(repositoryRoot, outputPath)}`);
