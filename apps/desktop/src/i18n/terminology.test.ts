import enUS from "./en-US/common.json";
import zhCN from "./zh-CN/common.json";
import { readFileSync } from "node:fs";
import path from "node:path";

// 术语守护（任务 11，规则冻结于 docs/archive/requirements/产品与交互设计.md §2.2 与实施计划任务 11）：
// - 用户可见动作键（按钮、步骤名、状态转换、空态引导）一律用“添加到 Agent/项目”“从 Agent/项目移除”，
//   批量派发统一使用“批量派发 / Batch dispatch”；这些键的中英文案都不得再出现「部署 / deploy」。
// - 「部署」只允许以冻结的名词短语（链接部署/复制部署/部署关系）或技术详情/诊断术语存在；
//   正向锁防止“一刀切删词”把技术详情里的「部署/解除部署」「符号链接」「目录联接」误删。
// - zh-CN/en-US 键集一致性仍由 ./i18n.test.ts 断言，本文件不重复承担该职责。

type Translations = Record<string, unknown>;

type TranslationLeaf = readonly [key: string, value: string];

function leaves(tree: Translations, prefix = ""): TranslationLeaf[] {
  return Object.entries(tree).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string") return [[key, value] as const];
    if (value !== null && typeof value === "object") return leaves(value as Translations, key);
    return [];
  });
}

function lookup(tree: Translations, key: string): string {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") throw new Error(`missing i18n key: ${key}`);
    node = (node as Translations)[part];
  }
  if (typeof node !== "string") throw new Error(`i18n key is not a string: ${key}`);
  return node;
}

// i18next 占位符（如 {{deployments_requiring_rediscovery}}）是后端契约字段名，不属于用户可见文案。
const I18NEXT_PLACEHOLDER = /\{\{[^}]*\}\}/g;

function zhActionViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = lookup(zhCN, key).replace(I18NEXT_PLACEHOLDER, "");
    return value.includes("部署") ? [`zh ${key} = ${lookup(zhCN, key)}`] : [];
  });
}

function enActionViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = lookup(enUS, key).replace(I18NEXT_PLACEHOLDER, "");
    return /deploy/i.test(value) ? [`en ${key} = ${lookup(enUS, key)}`] : [];
  });
}

// 名词键：「部署」只能出现在冻结短语（部署关系/链接部署/复制部署）内。
const FROZEN_ZH_NOUN_PHRASES = /部署关系|链接部署|复制部署/g;
const FROZEN_EN_NOUN_PHRASES = /deployment relations?|link deployment|copy deployment/gi;

function zhNounViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const residual = lookup(zhCN, key).replace(I18NEXT_PLACEHOLDER, "").replace(FROZEN_ZH_NOUN_PHRASES, "");
    return residual.includes("部署") ? [`zh ${key} 残留: ${residual}`] : [];
  });
}

function enNounViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const residual = lookup(enUS, key).replace(I18NEXT_PLACEHOLDER, "").replace(FROZEN_EN_NOUN_PHRASES, "");
    return /deploy/i.test(residual) ? [`en ${key} 残留: ${residual}`] : [];
  });
}

// 分片 1（入口动作）：批量操作区、Skill 详情/Agent/项目主操作、组合入口、边界声明。
const ENTRY_ACTION_KEYS = [
  "skillLibrary.page.batch.dispatch",
  "skillLibrary.page.batch.dispatchTitle",
  "skillLibrary.page.deployTargetBanner",
  "skillLibrary.combinations.deploy",
  "skillLibrary.combinations.deployHint",
  "agents.launchDeployment",
  "projects.detail.launchDeployment",
  "discovery.local.factReadOnly",
  "onboarding.compatibilityConfirmation",
  "onboarding.compatibilityDescription",
  "onboarding.contractUnavailable",
  "onboarding.scanDescription",
  "onboarding.skipDescription",
  "onboarding.rescanDescription",
  "projects.assemblyPlan.empty",
];

// 分片 2（流程文案）：部署流程与从目标移除流程的标题、步骤、按钮、状态与处置选项。
const FLOW_ACTION_KEYS = [
  "deployment.eyebrow",
  "deployment.errors.generic",
  "deployment.states.loading",
  "deployment.states.empty",
  "deployment.states.noSkills",
  "deployment.preview",
  "deployment.commit",
  "deployment.steps.label",
  "deployment.status.selecting",
  "deployment.status.previewReady",
  "deployment.status.committing",
  "deployment.status.results",
  "deployment.status.resultsWithFailures",
  "deployment.status.previewFailed",
  "deployment.plan.heading",
  "deployment.batch.heading",
  "deployment.batch.previewFailed",
  "deployment.batch.expandAgentsHint",
  "deployment.batch.committing",
  "deployment.results.heading",
  "deployment.results.status.message.succeeded",
  "deployment.results.status.message.failed",
  "deployment.results.failure.targetChanged",
  "deployment.results.failure.securityBlocked",
  "security.heading",
  "undeploy.eyebrow",
  "undeploy.heading",
  "undeploy.choiceLabel",
  "undeploy.choices.remove",
  "undeploy.confirm",
  "undeploy.submitting",
  "undeploy.loadError",
  "undeploy.commitError",
  "undeploy.recovery",
  "removal.description",
  "removal.retained",
  "removal.choiceLabel",
  "removal.choices.remove",
  "backup.uninstall.actions.undeploy_all",
];

// 分片 3（状态与筛选）：筛选选项、卡片/表格/状态栏计数、受管副本、杂项状态文案。
const STATUS_ACTION_KEYS = [
  "skillLibrary.filters.deployment",
  "skillLibrary.filters.deploymentOptions.any",
  "skillLibrary.filters.deploymentOptions.deployed",
  "skillLibrary.filters.deploymentOptions.notDeployed",
  "skillLibrary.page.card.deploymentCount_one",
  "skillLibrary.page.card.deploymentCount_other",
  "skillLibrary.table.agentDeploymentSummary",
  "skillLibrary.table.columns.agentDeployments",
  "skillLibrary.table.columns.projectDeployments",
  // §9 转正后旧状态栏（DetailStatusRail）已移除，其计数键随之删除。
  "agents.managedDeploymentCount",
  "agents.detail.managedDeployments",
  "projects.detail.managedDeployments.eyebrow",
  "projects.detail.managedDeployments.unavailable",
  "markdown.editor.saveHint",
  "importWorkflow.conflicts.impacts.copy",
  "operations.list.empty",
  "settings.network.localStillWorks",
];

// 分片 4（关系与矩阵）：技能详情关系区入口、矩阵引导、来源与目标标签。
// §9 转正后旧关系矩阵（RelationsPanel）、来源档案（ProvenancePanel）与轨迹面板
// 已随旧布局移除，其键不再受本守护约束。
const RELATION_ACTION_KEYS = [
  "skillLibrary.matrix.hint",
];

// 名词键：统计、关系行与处置选项中的「部署」只以冻结短语形式出现。
const NOUN_KEYS = [
  "agents.managedRelationsCount_one",
  "agents.managedRelationsCount_other",
  "projects.detail.managedDeployments.description",
  "projects.detail.managedDeployments.detach",
  "projects.detail.managedDeployments.confirm",
  "projects.detail.managedDeployments.confirmBody",
  "projects.detail.managedDeployments.detached",
  "projects.detail.managedDeployments.failed",
  "removal.choices.convert",
  "removal.choices.keep",
  "removal.batch.description",
  "removal.batch.noDeployments",
  "undeploy.description",
  "undeploy.sharedNotice",
  "undeploy.choices.keepShared",
  "undeploy.choices.keepCopy",
  "undeploy.retained",
  "skillLibrary.matrix.ariaLabel",
  "skillLibrary.matrix.loading",
  "pending.impact",
  "skillLibrary.page.batch.removeTagsRetained",
  "skillLibrary.combinations.deleteBody",
  "projects.assemblyPlan.detachNote",
  "dataProtection.restore.summary",
  "overview.chart.aria.agent",
  "overview.chart.aria.project",
  "overview.chart.axis.agent",
  "overview.chart.axis.project",
  "overview.chart.detailsLabel",
  "overview.chart.drilldown.agent",
  "overview.chart.drilldown.project",
  "overview.chart.eyebrow",
  "overview.chart.heading",
  "overview.chart.loading",
  "overview.chart.projectLimit",
  "overview.chart.scrollableDetails",
  "overview.chart.dimensionLabel",
  "overview.chart.empty.agent",
  "overview.chart.empty.project",
  "overview.metrics.names.deployments",
  "overview.page.description",
  "backup.uninstall.description",
  "backup.uninstall.loadingDeployments",
  "backup.uninstall.noDeployments",
  "backup.uninstall.selectDeployment",
  "backup.uninstall.impactSummary",
];

// 正向锁：派发方式和关系形式必须使用规范词；符号链接、目录联接只用于技术详情。
const TECHNICAL_LOCKS: ReadonlyArray<readonly [key: string, zh: string, en?: RegExp]> = [
  ["deployment.mode.label", "派发方式", /dispatch method/i],
  ["deployment.mode.symbolic_link", "符号链接", /symbolic link/i],
  ["deployment.mode.directory_junction", "目录联接", /directory junction/i],
  ["deployment.mode.managed_copy", "完整拷贝 · 管理中", /full copy · managed/i],
  ["deployment.results.failure.invalidCapability", "派发方式", /dispatch method/i],
  ["relationshipGovernance.relationship.managed_copy", "完整拷贝 · 管理中", /full copy · managed/i],
  ["relationshipGovernance.relationship.managed_link", "链接 · 管理中", /link · managed/i],
  ["relationshipGovernance.fileRepresentation.symbolic_link", "符号链接", /symbolic link/i],
  ["relationshipGovernance.fileRepresentation.directory_junction", "目录联接", /directory junction/i],
  ["settings.llm.protocol.azure_open_ai", "Azure OpenAI（部署级寻址）", /Azure OpenAI \(deployment-scoped\)/i],
  ["removal.choices.keep", "解除使用关系", /release the usage relationships/i],
  ["backup.uninstall.scenario", "解除全部使用关系", /release all usage relationships/i],
  ["settings.library.healthScope", "使用关系一致性检查", /usage-relationship consistency/i],
];

const CONFIRMED_RELATION_TERMS: ReadonlyArray<readonly [key: string, zh: string, en: string]> = [
  ["relationships.graph.edgeType.usage", "使用关系", "Usage relationship"],
  ["relationships.graph.edgeType.import_origin", "导入来源", "Import origin"],
  ["relationships.graph.edgeType.update_source", "更新来源", "Update source"],
  ["relationships.graph.edgeType.derived_from", "复用修改", "Derived from"],
  ["relationships.graph.edgeType.directory_ownership", "目录归属", "Directory location"],
  ["relationships.graph.edgeType.directory_recognition", "目录识别", "Directory recognition"],
  ["relationships.decisions.kind.duplicate_same_content", "同一技能", "Same skill"],
  ["relationships.decisions.kind.same_name_different_content", "重名", "Name taken"],
  ["relationships.governance.shortName.healthy", "正常", "Healthy"],
  ["relationships.governance.shortName.file_missing", "文件缺失", "Files missing"],
  ["relationships.governance.shortName.link_abnormal", "链接异常", "Link issue"],
  ["relationships.governance.shortName.content_changed", "内容变化", "Content changed"],
  ["relationships.governance.shortName.needs_sync", "待同步", "Sync pending"],
  ["relationships.governance.shortName.sync_failed", "同步失败", "Sync failed"],
  ["relationships.governance.shortName.unable_to_verify", "无法核验", "Unable to verify"],
  ["relationships.governance.shortName.user_confirmation", "待用户确认", "Awaiting your decision"],
  ["relationships.decisions.actions.centralize", "转入技能库管理", "Manage through skill library"],
  ["relationships.decisions.decision.centralize_management", "转入技能库管理", "Manage through skill library"],
  ["relationships.governance.manage.title", "转入技能库管理", "Manage through skill library"],
  ["relationships.governance.manage.confirm", "确认转入技能库管理", "Confirm management through the skill library"],
  ["skillDetail.sourceUpdates.actions.associate", "关联更新来源", "Associate update source"],
  ["skillDetail.sourceUpdates.actions.replace", "更换更新来源", "Replace update source"],
  ["skillDetail.sourceUpdates.actions.unlink", "解除更新来源", "Unlink update source"],
  ["skillDetail.sourceUpdates.actions.check", "检查更新", "Check for updates"],
];

const DEPRECATED_PRODUCT_WORDS: ReadonlyArray<readonly [lang: "zh" | "en", pattern: RegExp]> = [
  ["zh", /集中库|(?:待|已|转为|确认转为)集中管理|纳入技能库管理|副本|结束关系|完全重复|名称重复|可能匹配|搜索匹配|受管|托管|观察|(?:复制|链接)部署|复制派发|部署|管理拷贝/],
  ["en", /central[ -]library|centrally managed|manage(?:d|s|ing)? (?:\w+ )?centrally|end(ing)? (the |this )?relationship|managed (?:links?|cop(?:y|ies))|observed (?:links?|cop(?:y|ies))|(?:link|cop(?:y|ies)) deployments?|deployments? relationship|\b(?:un)?deploy(?:ment|ed|ing|s)?\b|^(?:Exact duplicates?|Same name(?:, different content)?|Possible match|Search-matched an existing Skill)$/i],
];

it("locks the frozen action verbs verbatim", () => {
  const marquee: ReadonlyArray<readonly [key: string, zh: string, en: string]> = [
    ["agents.launchDeployment", "添加到 Agent/项目", "Add to Agent/Project"],
    ["projects.detail.launchDeployment", "添加到 Agent/项目", "Add to Agent/Project"],
    ["undeploy.eyebrow", "从 Agent/项目移除", "Remove from Agent/Project"],
    ["skillLibrary.page.batch.dispatch", "批量派发", "Batch dispatch"],
    ["skillLibrary.page.batch.addCombinations", "批量加入组合", "Batch add to combinations"],
    ["skillLibrary.page.batch.removeCombinations", "批量移出组合", "Batch remove from combinations"],
    ["deployment.batch.heading", "添加 {{count}} 个 Skill", "Add {{count}} Skills"],
  ];
  for (const [key, zh, en] of marquee) {
    expect(lookup(zhCN, key)).toBe(zh);
    expect(lookup(enUS, key)).toBe(en);
  }
});

it("入口动作 keys never use 部署 as a verb", () => {
  expect(zhActionViolations(ENTRY_ACTION_KEYS)).toEqual([]);
  expect(enActionViolations(ENTRY_ACTION_KEYS)).toEqual([]);
});

it("流程文案 keys never use 部署 as a verb", () => {
  expect(zhActionViolations(FLOW_ACTION_KEYS)).toEqual([]);
  expect(enActionViolations(FLOW_ACTION_KEYS)).toEqual([]);
});

it("状态与筛选 keys never use 部署 as a verb", () => {
  expect(zhActionViolations(STATUS_ACTION_KEYS)).toEqual([]);
  expect(enActionViolations(STATUS_ACTION_KEYS)).toEqual([]);
});

it("关系与矩阵 keys never use 部署 as a verb", () => {
  expect(zhActionViolations(RELATION_ACTION_KEYS)).toEqual([]);
  expect(enActionViolations(RELATION_ACTION_KEYS)).toEqual([]);
});

it("noun keys use 部署 only inside the frozen relation phrases", () => {
  expect(zhNounViolations(NOUN_KEYS)).toEqual([]);
  expect(enNounViolations(NOUN_KEYS)).toEqual([]);
});

it("keeps technical-detail terms in place (positive locks)", () => {
  const missing: string[] = [];
  for (const [key, zhFragment, enPattern] of TECHNICAL_LOCKS) {
    if (!lookup(zhCN, key).includes(zhFragment)) missing.push(`zh ${key} 缺少「${zhFragment}」`);
    if (enPattern && !enPattern.test(lookup(enUS, key))) missing.push(`en ${key} misses ${String(enPattern)}`);
  }
  expect(missing).toEqual([]);
});

it("matches the confirmed bilingual relationship, conflict, status, and source-action terms", () => {
  const mismatches = CONFIRMED_RELATION_TERMS.flatMap(([key, zh, en]) => {
    try {
      const actualZh = lookup(zhCN, key);
      const actualEn = lookup(enUS, key);
      return actualZh === zh && actualEn === en
        ? []
        : [`${key}: zh=${JSON.stringify(actualZh)}; en=${JSON.stringify(actualEn)}`];
    } catch (error) {
      return [`${key}: ${error instanceof Error ? error.message : String(error)}`];
    }
  });
  expect(mismatches).toEqual([]);
});

it("does not let broad audit exceptions preserve deprecated product wording", () => {
  const technicalWordKeys = new Set(["settings.llm.protocol.azure_open_ai"]);
  const withoutPlaceholders = (value: string) => value.replace(I18NEXT_PLACEHOLDER, "");
  const violations = [
    ...leaves(zhCN).flatMap(([key, value]) =>
      !technicalWordKeys.has(key) && DEPRECATED_PRODUCT_WORDS[0][1].test(withoutPlaceholders(value)) ? [`zh ${key}: ${value}`] : [],
    ),
    ...leaves(enUS).flatMap(([key, value]) =>
      !technicalWordKeys.has(key) && DEPRECATED_PRODUCT_WORDS[1][1].test(withoutPlaceholders(value)) ? [`en ${key}: ${value}`] : [],
    ),
  ];
  const audit = readFileSync(path.resolve(process.cwd(), "../../scripts/terminology-audit.mjs"), "utf8");
  expect(audit).not.toContain("KEY_ALLOWLIST");
  expect(violations).toEqual([]);
});
