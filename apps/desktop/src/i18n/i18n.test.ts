import enUS from "./en-US/common.json";
import {
  createSkillHubI18n,
  flattenTranslationKeys,
  formatFileSize,
  resolveLocale,
} from "./index";
import zhCN from "./zh-CN/common.json";

it("ships identical translation key sets for Simplified Chinese and English", () => {
  expect(flattenTranslationKeys(enUS)).toEqual(flattenTranslationKeys(zhCN));
});

it("ships user-facing copy for every classified error key the UI maps to", () => {
  // P0-06：这些 key 是 nativeErrors/import 流程错误分类文案的落点，
  // 任一缺失都会让 i18next 把键名直接显示给用户。
  const requiredKeys = [
    "import.import_failed",
    "importWorkflow.aiPreCheck.errorNote",
    "importWorkflow.aiPreCheck.failureReadable",
    "importWorkflow.aiPreCheck.failureUnknown",
    "importWorkflow.errors.generic",
    "importWorkflow.errors.noDefaultAction",
    "importWorkflow.errors.remoteNotWired",
    "settings.llm.capabilityDisabled",
    "settings.llm.evidenceReferenceInvalid",
    "settings.llm.inputTooLarge",
    "source.providerAuthenticationUnavailable",
    "source.searchRateLimited",
    "source.searchUnavailable",
    "skillDetail.duplicates.deterministicNote",
    "skillDetail.duplicates.failureUnknown",
    "skillDetail.sourceRelink.failureUnknown",
    "discovery.search.assistUnconfigured",
    "discovery.search.assistCancelled",
    "discovery.search.assistFailedFallback",
    "discovery.search.assistUnknownFailure",
  ];
  const zhKeys = flattenTranslationKeys(zhCN);
  const enKeys = flattenTranslationKeys(enUS);
  for (const key of requiredKeys) {
    expect(zhKeys).toContain(key);
    expect(enKeys).toContain(key);
  }
});

it("uses Simplified Chinese only when the system preference requests Chinese", () => {
  expect(resolveLocale(["zh-Hans-CN", "en-US"])).toBe("zh-CN");
  expect(resolveLocale(["fr-FR", "en-GB"])).toBe("en-US");
});

it("uses the first supported language in system preference order", () => {
  expect(resolveLocale(["en-US", "zh-CN"])).toBe("en-US");
  expect(resolveLocale(["fr-FR", "zh-CN", "en-US"])).toBe("zh-CN");
});

it("switches language immediately without mutating the shared resources", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  expect(i18n.t("actions.close")).toBe("Close");

  await i18n.changeLanguage("zh-CN");

  expect(i18n.t("actions.close")).toBe("关闭");
});

it("formats file sizes through Intl for the active locale", () => {
  expect(formatFileSize(1536, "en-US")).toBe("1.5 kB");
  expect(formatFileSize(1536, "zh-CN")).toBe("1.5 kB");
});

it("ships readable copy for every governance workbench vocabulary the UI maps to", () => {
  // 治理工作台的筛选与行词表按动态键拼接（scope.${x} / statusFilter.${x} /
  // source.${x} / fingerprint.${x}）；任一缺失都会让 i18next 把键名直接
  // 渲染给用户（2026-09-25 验收缺陷）。
  const requiredKeys = [
    "relationships.governance.scope.all",
    "relationships.governance.scope.source_copy",
    "relationships.governance.scope.deployment",
    "relationships.governance.statusFilter.normal",
    "relationships.governance.statusFilter.retained",
    "relationships.governance.statusFilter.needs_validation",
    "relationships.governance.statusFilter.needs_attention",
    "relationships.governance.statusFilter.blocked",
    "relationships.governance.source.scan",
    "relationships.governance.source.import",
    "relationships.governance.source.agent_local",
    "relationships.governance.source.user_local",
    "relationships.governance.source.registered_project",
    "relationships.governance.source.online",
    "relationships.governance.source.central_library",
    "relationships.governance.source.legacy_unclassified",
    "relationshipGovernance.relationship.source_copy",
    "relationshipGovernance.relationship.import_copy",
    "relationshipGovernance.fingerprint.content_verified",
    "relationshipGovernance.fingerprint.name_only",
    "relationshipGovernance.fingerprint.diverged",
    "relationshipGovernance.fingerprint.normal",
    "relationshipGovernance.fingerprint.needs_validation",
    "relationshipGovernance.fingerprint.content_changed",
    "relationshipGovernance.fingerprint.permission_limited",
    "relationshipGovernance.fingerprint.managed_occupied",
    "relationshipGovernance.fingerprint.operation_failed",
  ];
  const zhKeys = flattenTranslationKeys(zhCN);
  const enKeys = flattenTranslationKeys(enUS);
  for (const key of requiredKeys) {
    expect(zhKeys).toContain(key);
    expect(enKeys).toContain(key);
  }
});
