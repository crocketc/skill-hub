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
  if (storyId === "US-060") return "v0.2.0（仅边界说明）";
  return "v0.2.0";
}

// US-046/US-047 已随 v0.2.0 LLM 能力接入完成实现；这里把已建立的真实测试
// 证据反向索引到生成的验收分支上。键是生成规则推导出的用例编号。
const evidenceOverrides = new Map([
  ["TC-US046-01", {
    automation: "crates/skillhub-application/tests/facade_safety_flow.rs：llm_check_runs_a_fresh_basic_check_first_and_links_it；llm_check_reuses_a_current_basic_run_instead_of_rerunning",
    result: "通过",
    evidence: "LLM-阶段5",
  }],
  ["TC-US046-02", {
    automation: "crates/skillhub-application/tests/facade_ai.rs：optional_ai_helpers_are_wired_without_network_or_implicit_writes（未配置返回 llm.not_configured，Severity::Info，不记为检查失败）；crates/skillhub-application/tests/facade_llm_admin.rs：capability_switches_gate_the_llm_commands（能力关闭返回 llm.capability_disabled）",
    result: "通过",
    evidence: "LLM-阶段5",
  }],
  ["TC-US046-03", {
    automation: "crates/skillhub-application/tests/facade_safety_flow.rs：llm_check_runs_a_fresh_basic_check_first_and_links_it（先运行基础检查并记录 basic_run_id）；evidence_sent_to_the_llm_masks_plaintext_credentials（遮盖明文凭据后才进入 LLM 请求）；crates/skillhub-adapters/tests/security_masking.rs：flagged_lines_lose_their_values_but_keep_their_keys",
    result: "通过",
    evidence: "LLM-阶段5",
  }],
  ["TC-US046-04", {
    automation: "crates/skillhub-adapters/tests/llm_safety_prompt.rs：safety_prompt_treats_skill_text_as_quoted_data（Skill 文本仅作为引号数据，无工具授权）；crates/skillhub-core/src/llm/safety.rs：SAFETY_PROMPT_VERSION 版本化提示词并进入检查记录 coverage_inputs",
    result: "通过",
    evidence: "LLM-阶段5",
  }],
  ["TC-US047-01", {
    automation: "crates/skillhub-application/tests/facade_llm_admin.rs：model_fetch_and_connection_test_use_the_configured_protocol（模型列表与两级连接测试）；saving_a_provider_stores_the_credential_and_reports_status（默认供应商解析）；crates/skillhub-adapters/tests/llm_protocol_contract.rs：openai_family_uses_bearer_and_json_schema_response_format 等 5 协议族契约；tests/e2e/llm-settings.spec.ts：the two-level connection test reports endpoint and model levels separately",
    result: "通过",
    evidence: "LLM-阶段3a、阶段9",
  }],
  ["TC-US047-02", {
    automation: "crates/skillhub-application/tests/facade_llm_admin.rs：saving_a_provider_stores_the_credential_and_reports_status（密钥只进入 CredentialStore，数据库仅存 llm-provider:{id} 引用）；deleting_a_provider_removes_its_credential_and_clears_the_default",
    result: "通过",
    evidence: "LLM-阶段2、阶段3b",
  }],
  ["TC-US047-03", {
    automation: "crates/skillhub-application/tests/facade_llm_admin.rs：capability_switches_gate_the_llm_commands（四项能力分项门控）；apps/desktop/src/features/settings/LlmCapabilitiesSettings.test.tsx：keeps every AI capability off until the user opts in；writes the full merged preference set when one capability is enabled（每项开关展示数据范围说明）",
    result: "通过",
    evidence: "LLM-阶段3b、阶段9",
  }],
  ["TC-US047-04", {
    automation: "crates/skillhub-application/tests/facade_ai.rs：duplicate_analysis_surfaces_deterministic_results_when_llm_fails（LLM 失败仍展示确定性结果并标注失败码）；crates/skillhub-application/tests/facade_ai.rs：optional_ai_helpers_are_wired_without_network_or_implicit_writes（未配置时明确返回可选功能不可用）",
    result: "通过",
    evidence: "LLM-阶段6",
  }],
  ["TC-US047-05", {
    version: "v0.2.0（仅边界说明）",
    automation: "边界说明：聊天、模型下载、训练微调、向量索引、多模型自动路由和复杂成本管理不在 v0.2.0 范围，命令契约与设置界面均无对应入口",
    result: "不适用（v0.2.0）",
    evidence: "docs/llm/用户配置与隐私说明-2026-09-10.md",
  }],
  ["TC-GR-09", {
    automation: "tests/e2e/bilingual-core-flows.spec.ts：core flows in English/navigation and core pages render English copy 等 12 条（zh-CN 与 en-US 下侧栏导航与核心页面关键文案均正确渲染）；apps/desktop/src/i18n/i18n.test.ts 与 zh/en 键集 parity 测试（双语键完整）；tests/e2e/keyboard-accessibility.spec.ts：keyboard focus and reduced motion remain visible in the preview shell（焦点可见）；组件层状态均以文本标签呈现（如 fixtures.ts expectBasicCheck 断言 \"Basic: Passed\" 文本）。真实系统缩放、减少动效与原生键盘行为的视觉判断留在 TC-GR-09-M01～M05",
    result: "通过",
    evidence: "浏览器自动化补齐轮（2026-09-10）",
  }],
  ["TC-GR-10", {
    automation: "tests/e2e/library-scale-300.spec.ts：300-skill catalog reaches the cached home within the GR-10 budget（300 Skill、每页 100 行时 DCL < 2s）+ 第二页可达 + 筛选仍可交互；tests/e2e/startup-performance.spec.ts：cached preview reaches the primary navigation within two seconds（约 80 Skill 缓存首页 < 2s）。边界：浏览器夹具无真实磁盘与数据库迁移，原生 I/O 性能留待桌面人工取证",
    result: "通过",
    evidence: "浏览器自动化补齐轮（2026-09-10）",
  }],
]);

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
    const id = `TC-${story.id.replace("-", "")}-${caseNumber}`;
    const override = evidenceOverrides.get(id);
    const future = versionFor(story.id) === "下一版本";
    rows.push({
      id,
      story: `${story.id} ${story.title}`,
      version: override?.version ?? versionFor(story.id),
      ...parsed,
      type: "自动化",
      automation: future
        ? "非 v0.2.0 范围；待下一版本建立证据"
        : override?.automation ?? "待反向索引；缺失时先补失败测试",
      result: future ? "不适用（v0.2.0）" : override?.result ?? "未执行",
      evidence: override?.evidence ?? "—",
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
    id: "TC-US021-06",
    story: "US-021 轻量编辑 Markdown",
    version: "v0.2.0",
    precondition: "进入编辑模式并输入长不可断行内容",
    action: "在常见桌面宽度（1440/1280/1024/900px）查看编辑分屏",
    expected: "源码编辑器与实时预览保持稳定左右分栏：编辑器盒子不溢出源码面板、预览不与源码面板重叠、页面无横向滚动",
    type: "自动化",
    automation: "tests/e2e/markdown-editor-layout.spec.ts：keeps source and preview side by side without overlap at 1440px/1280px/1024px/900px",
    result: "通过",
    evidence: "QA-011",
  },
  {
    id: "TC-US021-07",
    story: "US-021 轻量编辑 Markdown",
    version: "v0.2.0",
    precondition: "进入编辑模式并把窗口缩到小窗口边界（560px）",
    action: "查看编辑分屏布局",
    expected: "分屏收成上下堆叠：源码面板在上、预览在下互不压盖，编辑器不溢出视口",
    type: "自动化",
    automation: "tests/e2e/markdown-editor-layout.spec.ts：collapses to stacked panes at the small-window boundary (560px)",
    result: "通过",
    evidence: "QA-011",
  },
  {
    id: "TC-US021-08",
    story: "US-021 轻量编辑 Markdown",
    version: "v0.2.0",
    precondition: "编辑模式输入约 240 节长文档",
    action: "查看编辑分屏高度与预览滚动",
    expected: "分屏整体高度收敛到桌面上限（≤560px），预览面板 overflow-y 为 auto 且内容远高于面板时可在面板内独立滚动",
    type: "自动化",
    automation: "tests/e2e/markdown-workspace-bounds.spec.ts：edit split panes stay bounded and scroll independently with long content",
    result: "通过",
    evidence: "QA-012",
  },
  {
    id: "TC-US021-09",
    story: "US-021 轻量编辑 Markdown",
    version: "v0.2.0",
    precondition: "保存长文档并退回阅读模式",
    action: "查看阅读模式工作区高度",
    expected: "阅读内容区收敛到桌面上限（≤620px）并在内部滚动，不再无限撑高页面",
    type: "自动化",
    automation: "tests/e2e/markdown-workspace-bounds.spec.ts：read mode workspace stays bounded after saving a long document",
    result: "通过",
    evidence: "QA-012",
  },
  {
    id: "TC-US021-10",
    story: "US-021 轻量编辑 Markdown",
    version: "v0.2.0",
    precondition: "通过复制导入形成中央库托管副本",
    action: "读取 SKILL.md 查询所有权",
    expected: "查询结果携带领域所有权判定：托管副本可编辑且无只读原因，允许显式保存原文并形成新版本；前端映射 readOnlyReason 不伪造所有权",
    type: "自动化",
    automation: "crates/skillhub-application/tests/facade.rs：read_markdown_file_reports_ownership_from_the_domain_matrix；apps/desktop/src/features/markdown/nativeApi.test.ts：maps Markdown content with its native editability",
    result: "通过",
    evidence: "QA-013",
  },
  {
    id: "TC-US021-11",
    story: "US-021 轻量编辑 Markdown",
    version: "v0.2.0",
    precondition: "内容来源为内置、插件、未接管外部目录或权限受限",
    action: "查询领域所有权矩阵判定",
    expected: "四类非托管来源一律只读并携带对应只读原因（builtin/plugin/external/permission），只能复制导入或接管，不开放原文覆盖",
    type: "自动化",
    automation: "crates/skillhub-core/src/catalog/ownership.rs：managed_copies_stay_editable_without_read_only_reason；builtin_plugin_external_and_permission_denied_content_stays_read_only",
    result: "通过",
    evidence: "QA-013",
  },
  {
    id: "TC-US008-06",
    story: "US-008 发现并区分 Agent 客户端",
    version: "v0.2.0",
    precondition: "界面展示按品牌分组的 Agent（品牌已有内置 Logo 素材）",
    action: "查看品牌标签",
    expected: "已有素材的品牌在颜色标签内渲染对应真实 Logo；zcode 复用 zai.svg，claude/anthropic 与 hermes/hermes-agent 按目录映射",
    type: "自动化",
    automation: "apps/desktop/src/ui/BrandTag.test.tsx：renders the bundled logo asset for known brands；maps zcode to the zai logo asset；maps claude and hermes profile ids to their catalog logo assets；tests/e2e/brand-assets.spec.ts：the browser decodes every shipped brand logo（真实浏览器经 HTTP 加载并解码全部素材）",
    result: "通过",
    evidence: "QA-014",
  },
  {
    id: "TC-US008-07",
    story: "US-008 发现并区分 Agent 客户端",
    version: "v0.2.0",
    precondition: "出现未识别品牌或素材目录发生变化",
    action: "查看品牌标签与映射完整性校验",
    expected: "未识别品牌保持中性颜色标签与首字母大写名称，不伪造图标；映射与 public/brand/agents/lobehub 下 17 个素材双向一一对应",
    type: "自动化",
    automation: "apps/desktop/src/ui/BrandTag.test.tsx：keeps unknown brands on the neutral color tag without an invented logo；covers every shipped lobehub asset with a mapping and vice versa；tests/e2e/brand-assets.spec.ts：an unknown brand asset is not served as an image（未知素材不被伪装成图片）",
    result: "通过",
    evidence: "QA-014",
  },
  {
    id: "TC-US051-07",
    story: "US-051 安全删除 Skill",
    version: "v0.2.0",
    precondition: "目录中存在带声明依赖的 Skill、包含它的组合、固定版本与共享项目配置，且 Agent 根下有同名未托管目录",
    action: "触发 PrepareDeleteSkill 影响预览",
    expected: "影响结果完整报告部署、声明依赖、组合、固定版本（项目+版本）、项目配置、相关 Skill 和未知外部引用路径；未知内容只提示不修改",
    type: "自动化",
    automation: "crates/skillhub-application/tests/facade.rs：prepare_delete_reports_the_full_deletion_impact_matrix",
    result: "通过",
    evidence: "QA-001",
  },
  {
    id: "TC-US051-08",
    story: "US-051 安全删除 Skill",
    version: "v0.2.0",
    precondition: "批量删除影响对话框已列出部署处理方式与完整影响矩阵",
    action: "点击继续后完成二次点击确认并提交",
    expected: "不再要求输入 FORCE DELETE 文本；第一次点击只武装确认按钮，第二次点击才提交；提交中显示执行状态；各 Skill 影响维度（组合、相关 Skill、固定版本、声明依赖、未知外部引用）逐项展示",
    type: "自动化",
    automation: "apps/desktop/src/features/removal/BatchRemovalImpactDialog.test.tsx：requires impact choices and a second click confirmation without typed phrases；shows the extra impact dimensions per skill；reports an executing state while the batch is submitting",
    result: "通过",
    evidence: "QA-001",
  },
  {
    id: "TC-US051-09",
    story: "US-051 安全删除 Skill",
    version: "v0.2.0",
    precondition: "批量删除提交完成并生成逐项结果",
    action: "查看批量操作汇总",
    expected: "汇总先显示成功/失败数量；成功项只计数不再逐条铺开，未成功项保持展开供处理",
    type: "自动化",
    automation: "apps/desktop/src/ui/BatchOperationSummary.test.tsx：shows succeeded outcomes as counts only and expands the rest",
    result: "通过",
    evidence: "QA-001",
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
  const ruleId = `TC-GR-${String(rule.number).padStart(2, "0")}`;
  const override = evidenceOverrides.get(ruleId);
  rows.push({
    id: ruleId,
    story: `GR-${String(rule.number).padStart(2, "0")} 全局验收规则`,
    version: "v0.2.0",
    precondition: "执行任一受该全局规则约束的功能",
    action: "执行对应成功、失败、取消、重复、恢复或受限分支",
    expected: clean(rule.text),
    type: "自动化",
    automation: override?.automation ?? "待反向索引；缺失时先补失败测试",
    result: override?.result ?? "未执行",
    evidence: override?.evidence ?? "—",
  });
});

const manualCases = [
  ["TC-US001-M01", "US-001 初始化集中库", "Windows 或 macOS 首次启动且集中库尚未确认", "打开原生目录选择器后取消", "向导保持可操作且不写入集中库路径或内容", "QA-002"],
  ["TC-US001-M02", "US-001 初始化集中库", "Windows 或 macOS 首次启动且有测试专用空目录", "通过原生目录选择器确认自定义目录", "向导显示所选真实路径并允许继续初始化", "QA-002"],
  ["TC-US045-M01", "US-045 安全处理 Skill 中的凭证", "系统安全凭据存储可用", "保存测试专用占位凭据", "凭据仅进入系统安全存储，不进入集中库、备份或日志", "—"],
  ["TC-US045-M02", "US-045 安全处理 Skill 中的凭证", "系统安全凭据存储中存在测试专用占位凭据", "清除该测试凭据", "凭据被移除且其他应用凭据不受影响", "—"],
  ["TC-US047-M01", "US-047 配置可选 LLM 能力", "Windows 或 macOS 真实系统凭据存储可用", "保存一个测试专用 LLM API 密钥并检查磁盘文件", "密钥只出现在系统凭据存储（钥匙串/凭据管理器），集中库文件、备份与标准导出均无密钥明文", "—"],
  ["TC-US047-M02", "US-047 配置可选 LLM 能力", "真实桌面应用中已配置一个在线 LLM 供应商", "在设置页对真实服务执行两级连接测试", "服务可达与模型连接分别展示；仅模型级通过才显示“模型连接可用”，失败时展示稳定错误码", "—"],
  ["TC-US046-M01", "US-046 执行独立的 AI 安全检查", "真实桌面应用已配置供应商且测试 Skill 含占位敏感内容", "对测试 Skill 运行 AI 安全检查", "先显示基础检查结果；发送前遮盖明文凭据；基础与 AI 结果分别展示，AI 不自动修改文件", "—"],
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
