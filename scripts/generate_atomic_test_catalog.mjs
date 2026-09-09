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
