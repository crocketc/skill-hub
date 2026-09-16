import enUS from "./en-US/common.json";
import zhCN from "./zh-CN/common.json";

// 术语守护（任务 11，规则冻结于 docs/产品与交互设计.md §2.2 与实施计划任务 11）：
// - 用户可见动作键（按钮、步骤名、状态转换、空态引导）一律用“添加到 Agent/项目”“从 Agent/项目移除”，
//   批量用“添加到…”“添加 N 个 Skill”；这些键的中英文案都不得再出现「部署 / deploy」。
// - 「部署」只允许以冻结的名词短语（链接部署/复制部署/部署关系）或技术详情/诊断术语存在；
//   正向锁防止“一刀切删词”把技术详情里的「部署/解除部署」「符号链接」「目录联接」误删。
// - zh-CN/en-US 键集一致性仍由 ./i18n.test.ts 断言，本文件不重复承担该职责。

type Translations = Record<string, unknown>;

function lookup(tree: Translations, key: string): string {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") throw new Error(`missing i18n key: ${key}`);
    node = (node as Translations)[part];
  }
  if (typeof node !== "string") throw new Error(`i18n key is not a string: ${key}`);
  return node;
}

function zhActionViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = lookup(zhCN, key);
    return value.includes("部署") ? [`zh ${key} = ${value}`] : [];
  });
}

function enActionViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = lookup(enUS, key);
    return /deploy/i.test(value) ? [`en ${key} = ${value}`] : [];
  });
}

// 名词键：「部署」只能出现在冻结短语（部署关系/链接部署/复制部署）内。
const FROZEN_ZH_NOUN_PHRASES = /部署关系|链接部署|复制部署/g;
const FROZEN_EN_NOUN_PHRASES = /deployment relations?|link deployment|copy deployment/gi;

function zhNounViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const residual = lookup(zhCN, key).replace(FROZEN_ZH_NOUN_PHRASES, "");
    return residual.includes("部署") ? [`zh ${key} 残留: ${residual}`] : [];
  });
}

function enNounViolations(keys: string[]): string[] {
  return keys.flatMap((key) => {
    const residual = lookup(enUS, key).replace(FROZEN_EN_NOUN_PHRASES, "");
    return /deploy/i.test(residual) ? [`en ${key} 残留: ${residual}`] : [];
  });
}

// 分片 1（入口动作）：批量操作区、Skill 详情/Agent/项目主操作、组合入口、边界声明。
const ENTRY_ACTION_KEYS = [
  "skillLibrary.page.batch.addTo",
  "skillLibrary.page.batch.addToTitle",
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
  "onboarding.selectionConfirmation",
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
  "skillDetail.statusRail.deployments_one",
  "skillDetail.statusRail.deployments_other",
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
const RELATION_ACTION_KEYS = [
  "skillDetail.relations.undeploy",
  "skillDetail.relations.undeployTarget",
  "skillLibrary.matrix.hint",
  "skillDetail.provenance.heading",
  "skillDetail.provenance.noObservedDeployments",
  "skillDetail.trajectory.label",
  "skillDetail.trajectory.deployments",
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
  "skillDetail.relations.loadError",
  "skillDetail.relations.governed.empty",
  "skillLibrary.matrix.ariaLabel",
  "skillLibrary.matrix.loading",
  "skillDetail.navigation.sections.relations",
  "pending.impact",
  "skillLibrary.page.batch.removeTagsRetained",
  "skillLibrary.combinations.deleteBody",
  "skillDetail.sourceUpdate.reconcile",
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

// 正向锁：技术详情/诊断术语必须原样保留，防止后续“一刀切删词”。
const TECHNICAL_LOCKS: ReadonlyArray<readonly [key: string, zh: string, en?: RegExp]> = [
  ["deployment.mode.label", "部署方式", /deployment mode/i],
  ["deployment.mode.symbolic_link", "符号链接", /symbolic link/i],
  ["deployment.mode.directory_junction", "目录联接", /directory junction/i],
  ["deployment.mode.managed_copy", "托管复制", /managed copy/i],
  ["deployment.results.failure.invalidCapability", "部署方式", /deployment mode/i],
  ["relationshipGovernance.relationship.managed_copy", "复制部署", /copy deployment/i],
  ["relationshipGovernance.relationship.managed_link", "链接部署", /link deployment/i],
  ["relationshipGovernance.fileRepresentation.symbolic_link", "符号链接", /symbolic link/i],
  ["relationshipGovernance.fileRepresentation.directory_junction", "目录联接", /directory junction/i],
  ["removal.choices.keep", "解除部署关系"],
  ["backup.uninstall.scenario", "解除全部部署", /undeploy everything/i],
  ["settings.library.healthScope", "部署一致性检查", /deployment consistency/i],
  ["skillDetail.relations.governed.loadError", "部署与来源信息", /deployment and source details/i],
];

it("locks the frozen action verbs verbatim", () => {
  const marquee: ReadonlyArray<readonly [key: string, zh: string, en: string]> = [
    ["agents.launchDeployment", "添加到 Agent/项目", "Add to Agent/Project"],
    ["projects.detail.launchDeployment", "添加到 Agent/项目", "Add to Agent/Project"],
    ["undeploy.eyebrow", "从 Agent/项目移除", "Remove from Agent/Project"],
    ["skillLibrary.page.batch.addTo", "添加到…", "Add to…"],
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
