import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type DeploymentTarget,
  type FindingDisposition,
  type SkillResult,
  type UpdateDecision,
  type UpstreamCheckResult,
} from "../../api/bindings";
import {
  SkillDetailUnavailableError,
  unavailableSkillDetailFacade,
  type SkillDetailFacade,
  type SkillDetailInsights,
  type SkillDetailSummary,
  type SkillFinding,
  type SkillMetadata,
  type SkillMetadataPatch,
  type SkillRelation,
  type SkillRollbackImpact,
  type SemanticDuplicateReport,
  type SkillTranslation,
  type SkillVersionDiff,
  type SkillVersionEntry,
} from "./api";

function unavailableResult(): SkillDetailUnavailableError {
  return new SkillDetailUnavailableError();
}

function asSkill(result: AppQueryResult): SkillResult {
  if (result.type !== "skill") throw unavailableResult();
  return result.payload;
}

function lifecycleOf(skill: SkillResult): SkillDetailSummary["lifecycle"] {
  if (skill.trial_due) return "trial";
  return skill.lifecycle === "Normal" ? "active" : "archived";
}

async function getSkill(skillId: string): Promise<SkillResult> {
  try {
    return asSkill(
      await queryApplication({ type: "get_skill", payload: { skill_id: skillId } }),
    );
  } catch (error) {
    if (error instanceof SkillDetailUnavailableError) throw error;
    throw unavailableResult();
  }
}

function summaryOf(skill: SkillResult): SkillDetailSummary {
  return {
    agentDeploymentCount: 0,
    aiCheck: "not_run",
    basicCheck: "not_run",
    // QA-010：概览展示后端推导的可读标签，内容哈希不进入展示层。
    currentVersion: skill.current_version_label ?? "unknown",
    highRiskCount: 0,
    id: skill.skill_id,
    lifecycle: lifecycleOf(skill),
    name: skill.display_name,
    pendingCount: 0,
    projectDeploymentCount: 0,
    // P1-12：概览是全页唯一的用途陈述（头部不再重复）。口径：用户用途优先
    // （QA-008），缺省回退持久化译文，再回退原文，绝不留空。
    purpose: skill.user_purpose ?? skill.translated_description ?? skill.original_description,
    trialDue: skill.trial_due ?? undefined,
    upgradeAvailable: false,
  };
}

function checkStateOf(state: "not_checked" | "running" | "passed" | "failed"):
  SkillDetailSummary["basicCheck"] {
  if (state === "not_checked") return "not_run";
  if (state === "running") return "warning";
  return state;
}

async function checkState(
  skillId: string,
  versionId: string,
  kind: "basic" | "llm",
): Promise<SkillDetailSummary["basicCheck"]> {
  const result = await queryApplication(
    kind === "basic"
      ? { type: "get_basic_check_result", payload: { skill_id: skillId, version_id: versionId } }
      : { type: "get_llm_safety_check_result", payload: { skill_id: skillId, version_id: versionId } },
  );
  const expectedType = kind === "basic" ? "basic_check_result" : "llm_safety_check_result";
  if (result.type !== expectedType) throw unavailableResult();
  return checkStateOf(result.payload.state);
}

/** Maps the persisted description translation (if any) to the UI contract. */
async function translationOf(skillId: string): Promise<SkillTranslation | undefined> {
  const result = await queryApplication({
    type: "list_translations",
    payload: { skill_id: skillId },
  });
  if (result.type !== "translations") throw unavailableResult();
  const view = result.payload[0];
  if (!view) return undefined;
  return {
    locale: view.record.language,
    model: view.record.provenance.model,
    sourceVersion: view.version_id ?? "current",
    stale: view.needs_update,
    text: view.record.text,
    translatedAt: view.updated_at,
    userRevised: view.record.origin === "user_revision",
  };
}

function metadataOf(skill: SkillResult, translation?: SkillTranslation): SkillMetadata {
  return {
    alias: skill.display_name,
    license: skill.license ?? undefined,
    note: skill.user_note ?? undefined,
    originalDescription: skill.original_description,
    // QA-008：用途是用户独立撰写的字段，不得用原文或译文冒充。
    purpose: skill.user_purpose ?? "",
    tags: skill.tags,
    translation,
  };
}

/** 保存用户修订译文：hash 留空表示“按当前原文计算”，避免前端复算后端哈希。 */
async function saveTranslationRevision(
  skillId: string,
  language: string,
  text: string,
): Promise<void> {
  const listResult = await queryApplication({
    type: "list_translations",
    payload: { skill_id: skillId },
  });
  if (listResult.type !== "translations") throw unavailableResult();
  const sourceDescriptionHash =
    listResult.payload[0]?.record.provenance.source_description_hash ?? "";
  const result: AppCommandResult = await executeCommand({
    type: "save_user_translation_revision",
    payload: {
      skill_id: skillId,
      language,
      source_description_hash: sourceDescriptionHash,
      text,
    },
  });
  if (result.type !== "translation_result") throw unavailableResult();
}

/** QA-008：set_metadata 是整体覆盖命令；先读取当前值合并补丁，
 * 避免只改一个字段时丢失标签、作者或许可证。 */
async function saveMetadata(skillId: string, patch: SkillMetadataPatch): Promise<void> {
  // 译文修订走独立的 save_user_translation_revision 契约；清空（null）不是
  // 需求内的操作，保持原值不动。
  if (typeof patch.translationText === "string" && patch.translationText !== "") {
    const current = await translationOf(skillId);
    await saveTranslationRevision(
      skillId,
      current?.locale ?? "zh-CN",
      patch.translationText,
    );
  }
  const skill = await getSkill(skillId);
  const result: AppCommandResult = await executeCommand({
    type: "set_metadata",
    payload: {
      skill_id: skillId,
      display_name: patch.alias === undefined
        ? skill.display_name
        : patch.alias?.trim() || skill.runtime_name,
      note: patch.note === undefined ? skill.user_note : patch.note || null,
      tags: patch.tags === undefined ? skill.tags : patch.tags,
      author: skill.author,
      license: skill.license,
      user_purpose: patch.purpose === undefined ? skill.user_purpose : patch.purpose || null,
    },
  });
  if (result.type !== "operation_summary") throw unavailableResult();
}

/** AR-021：把原生版本记录映射为用户可读条目——有序号用 vN，
 * 时间未知回退短哈希；完整哈希不再直接作为版本名展示。 */
function shortHash(versionId: string): string {
  if (versionId.startsWith("sha256:")) {
    const hex = versionId.slice("sha256:".length);
    return `sha256:${hex.slice(0, 8)}…`;
  }
  return versionId.slice(0, 18);
}

async function getVersions(skillId: string): Promise<SkillVersionEntry[]> {
  const result = await queryApplication({
    type: "list_versions",
    payload: { skill_id: skillId },
  });
  if (result.type !== "versions") throw unavailableResult();
  return result.payload.map((version) => {
    const epoch = version.created_at_epoch ?? null;
    const sequence = version.sequence ?? null;
    return {
      changes: {
        added: version.added,
        changed: version.changed,
        removed: version.removed,
      },
      createdAt: epoch
        ? new Date(Number(epoch) * 1000).toLocaleString()
        : "",
      createdAtEpoch: epoch,
      current: version.current,
      id: version.version_id,
      label: sequence !== null ? `v${sequence}` : shortHash(version.version_id),
      sequence,
    };
  });
}

async function getVersionDiff(
  _skillId: string,
  leftVersionId: string,
  rightVersionId: string,
): Promise<SkillVersionDiff> {
  const result = await queryApplication({
    type: "diff_versions",
    payload: { left: leftVersionId, right: rightVersionId },
  });
  if (result.type !== "version_diff") throw unavailableResult();
  return {
    added: result.payload.added,
    changed: result.payload.changed,
    leftVersionId,
    removed: result.payload.removed,
    rightVersionId,
  };
}

async function getRollbackImpact(
  skillId: string,
  versionId: string,
): Promise<SkillRollbackImpact> {
  const relationsResult = await queryApplication({
    type: "get_deployment_relations",
    payload: { skill_id: skillId },
  });
  if (relationsResult.type !== "deployment_relations") throw unavailableResult();
  const targetsResult = await queryApplication({
    type: "list_deployment_targets",
    payload: null,
  });
  const targets =
    targetsResult.type === "deployment_targets"
      ? new Map(targetsResult.payload.map((target) => [target.id, target]))
      : new Map<string, DeploymentTarget>();
  return {
    deployments: relationsResult.payload.map((relation) => ({
      affected: true,
      id: relation.id,
      label: targets.get(relation.target_id)?.label ?? relation.target_id,
      pinned: false,
      version: relation.version_id,
    })),
    rerunsBasicCheck: true,
    targetVersionId: versionId,
  };
}


async function checkSourceUpdate(skillId: string): Promise<UpstreamCheckResult> {
  const result = await executeCommand({
    type: "check_source_update",
    payload: { skill_id: skillId },
  });
  if (result.type !== "upstream_check_result") throw unavailableResult();
  return result.payload;
}

async function applySourceUpdate(skillId: string, decision: UpdateDecision) {
  const result = await executeCommand({
    type: "apply_source_update",
    payload: { skill_id: skillId, decision },
  });
  if (result.type !== "applied_source_update") throw unavailableResult();
  return result.payload;
}

async function relinkSource(skillId: string, sourceInput: string) {
  const trimmed = sourceInput.trim();
  const locator = /^https:\/\//i.test(trimmed)
    ? { https_url: trimmed }
    : /\.git$/i.test(trimmed) || /^git@/i.test(trimmed)
      ? { git_url: trimmed }
      : { local_path: trimmed };
  const kind = "https_url" in locator ? "https" : "git_url" in locator ? "git" : "local";
  const result = await executeCommand({
    type: "relink_source",
    payload: { skill_id: skillId, source: { kind, locator } },
  });  if (result.type !== "operation_summary") throw unavailableResult();
  return { messageCode: result.payload.message_code };
}

export const nativeSkillDetailFacade: SkillDetailFacade = {
  ...unavailableSkillDetailFacade,
  checkSourceUpdate,
  applySourceUpdate,
  relinkSource,
  analyzeSemanticDuplicates: analyzeNativeSemanticDuplicates,
  async emitIntent(intent) {
    if (intent.type === "translate_description") {
      const result: AppCommandResult = await executeCommand({
        type: "translate_description",
        payload: {
          skill_id: intent.skillId,
          language: intent.locale,
          // 确认覆盖用户修订后允许重新生成（需求 5.35）。
          overwrite_user_revision: intent.overwriteUserRevision,
        },
      });
      if (result.type !== "translation_result") throw unavailableResult();
      return;
    }
    if (intent.type === "abandon_trial") {
      const result: AppCommandResult = await executeCommand({
        type: "set_trial",
        payload: { skill_id: intent.skillId, due: null },
      });
      if (result.type !== "operation_summary") throw unavailableResult();
      return;
    }
    throw unavailableResult();
  },
  getVersions,
  getVersionDiff,
  getRollbackImpact,
  async commitRollback(skillId, versionId) {
    await setNativeCurrentVersion(skillId, versionId);
    // set_current_version 切换目录指针；"新当前版本"即被切换到的版本。
    return { newVersionId: versionId };
  },
  async setVersionLabel(skillId, versionId, label) {
    const result: AppCommandResult = await executeCommand({
      type: "set_version_label",
      payload: { skill_id: skillId, version_id: versionId, label },
    });
    if (result.type !== "operation_summary") throw unavailableResult();
  },
  async getSummary(skillId) {
    const skill = await getSkill(skillId);
    const summary = summaryOf(skill);
    if (!skill.current_version) return summary;
    const [basicCheck, aiCheck] = await Promise.all([
      checkState(skillId, skill.current_version, "basic"),
      checkState(skillId, skill.current_version, "llm"),
    ]);
    return { ...summary, aiCheck, basicCheck };
  },
  async getMetadata(skillId) {
    // 译文是附属信息：查询失败只降级为“无译文”，不得拖垮整个元数据面板。
    const [skill, translation] = await Promise.all([
      getSkill(skillId),
      translationOf(skillId).catch(() => undefined),
    ]);
    return metadataOf(skill, translation);
  },
  saveMetadata,
  async getRelations(skillId): Promise<SkillRelation[]> {
    const relationsResult = await queryApplication({
      type: "get_deployment_relations",
      payload: { skill_id: skillId },
    });
    if (relationsResult.type !== "deployment_relations") throw unavailableResult();
    const targetsResult = await queryApplication({ type: "list_deployment_targets", payload: null });
    if (targetsResult.type !== "deployment_targets") throw unavailableResult();
    const targets = new Map(targetsResult.payload.map((target) => [target.id, target]));
    return relationsResult.payload.map((relation) => {
      const target = targets.get(relation.target_id);
      const targetPath = target?.path.replace(/[\\/]+$/, "") ?? relation.target_id;
      return {
        affectedByCurrentVersion: true,
        id: relation.id,
        kind: relation.target_id.startsWith("project") ? "project" : "agent",
        label: target?.label ?? relation.target_id,
        logicalTarget: relation.target_id,
        physicalTarget: `${targetPath}/${relation.runtime_name}`,
        pinned: false,
        version: relation.version_id,
      };
    });
  },
  async getFindings(skillId, versionId, kind): Promise<SkillFinding[]> {
    const result = await queryApplication({
      type: "list_findings",
      payload: {
        skill_id: skillId,
        version_id: versionId,
        kind: kind === "basic" ? "basic" : "llm",
      },
    });
    if (result.type !== "findings") throw unavailableResult();
    return result.payload.map((finding) => ({
      code: finding.code,
      disposition: finding.disposition,
      file: finding.file ?? undefined,
      highRisk: finding.high_risk,
      id: finding.id,
      severity: finding.severity,
    }));
  },
  async getInsights(skillId): Promise<SkillDetailInsights> {
    const result = await queryApplication({
      type: "list_skill_operations",
      payload: { skill_id: skillId },
    });
    if (result.type !== "skill_operations") throw unavailableResult();
    const duplicates = await queryApplication({
      type: "list_deterministic_duplicates",
      payload: { skill_id: skillId },
    });
    if (duplicates.type !== "deterministic_duplicates") throw unavailableResult();
    const insights: SkillDetailInsights = {
      combinations: [],
      dependencies: [],
      deterministicDuplicates: duplicates.payload.map((entry) => entry.label),
      externalChanges: [],
      operationHistory: result.payload.entries.map((entry) => ({
        id: entry.operation_id,
        label: [entry.kind, entry.phase, entry.error_code ?? undefined]
          .filter((part) => part !== undefined)
          .join(" · "),
      })),
    };
    if (result.payload.limitation) {
      insights.operationHistoryLimitation = result.payload.limitation;
    }
    return insights;
  },
};

/** Applies an explicit disposition to a persisted security finding. */
export async function setNativeFindingDisposition(
  skillId: string,
  versionId: string,
  kind: "basic" | "llm",
  findingId: string,
  disposition: FindingDisposition,
  highRiskConfirmed: boolean,
): Promise<void> {
  const result: AppCommandResult = await executeCommand({
    type: "set_finding_disposition",
    payload: {
      skill_id: skillId,
      version_id: versionId,
      kind,
      finding_id: findingId,
      disposition,
      high_risk_confirmed: highRiskConfirmed,
    },
  });
  if (result.type !== (kind === "basic" ? "basic_check_result" : "llm_safety_check_result")) {
    throw unavailableResult();
  }
}

/** Runs the optional AI layer over the deterministic duplicate candidates.
 * The backend always carries the deterministic layer back, so an LLM failure
 * still yields a usable report with `deterministic_only` + failure code. */
export async function analyzeNativeSemanticDuplicates(
  skillId: string,
): Promise<SemanticDuplicateReport> {
  const result: AppCommandResult = await executeCommand({
    type: "analyze_semantic_duplicates",
    payload: { skill_id: skillId },
  });
  if (result.type !== "duplicate_analysis") throw unavailableResult();
  const analysis = result.payload;
  return {
    candidates: (analysis.candidates ?? []).map((candidate) => ({
      basicCheckState: candidate.basic_check_state,
      description: candidate.description,
      id: candidate.skill_id,
      locallyModified: candidate.locally_modified,
      name: candidate.name,
      permissions: candidate.permissions,
      source: candidate.source,
      trigger: candidate.trigger,
    })),
    failureCode: analysis.failure_code ?? null,
    source: analysis.source ?? "deterministic_only",
  };
}

/** Switches the catalog pointer to an existing version after native validation. */
export async function setNativeCurrentVersion(
  skillId: string,
  versionId: string,
): Promise<void> {
  const result: AppCommandResult = await executeCommand({
    type: "set_current_version",
    payload: { skill_id: skillId, version_id: versionId },
  });
  if (result.type !== "operation_summary") throw unavailableResult();
}
