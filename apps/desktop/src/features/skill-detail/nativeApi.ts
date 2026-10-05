import {
  executeCommand,
  queryApplication,
  type AnalyzeConflictScope,
  type AppliedSourceUpdate,
  type AppCommandResult,
  type AppQueryResult,
  type ConflictAnalysis,
  type DeploymentTarget,
  type FindingDisposition,
  type SkillMetadataPatch as NativeSkillMetadataPatch,
  type SkillResult,
  type SourceUpdatePreview,
  type SourceUpdateStatus,
  type UpdateDecision,
  type UpstreamCheckResult,
} from "../../api/bindings";
import { indexTargetsByAnyId } from "../deployment/targetProjection";
import { checkStateOf } from "../shared/checkState";
import { skillHubI18n } from "../../i18n";
import { usableLlmProviderLabel } from "../settings/llmApi";
import {
  SkillDetailUnavailableError,
  unavailableSkillDetailFacade,
  type SkillDetailFacade,
  type SkillDetailInsights,
  type SkillDetailSummary,
  type SkillMetadata,
  type SkillMetadataPatch,
  type SkillObservedDeployment,
  type SkillProvenance,
  type SkillImportProvenance,
  type SkillRelation,
  type SkillRollbackImpact,
  type SemanticDuplicateReport,
  type SkillTranslation,
  type SkillVersionDiff,
  type SkillVersionEntry,
  type SourceRelinkInput,
} from "./api";

// G-18：操作历史的 message_code 形如 `insights.operation.<类别>.<结果>`；
// 类别/结果先收敛为 i18n 键，未登记的新码回退通用词，不把机器码裸露给用户。
const INSIGHTS_OPERATION_CATEGORIES: Record<string, string> = {
  combination_changed: "combinationChanged",
  content_saved: "contentSaved",
  deployment_reconciled: "deploymentReconciled",
  preference_changed: "preferenceChanged",
  skill_added: "skillAdded",
  skill_operation: "skillOperation",
  skill_removed: "skillRemoved",
  source_changed: "sourceChanged",
};
const INSIGHTS_OPERATION_OUTCOMES: Record<string, string> = {
  failed: "failed",
  in_progress: "inProgress",
  needs_recovery: "needsRecovery",
  rolled_back: "rolledBack",
  succeeded: "succeeded",
};
// G-18：关系形态码（后端稳定枚举）；`unknown` 是真实的"形态未知"事实。
const INSIGHTS_DEPENDENCY_SHAPES: Record<string, string> = {
  import_copy: "importCopy",
  managed_copy: "managedCopy",
  managed_link: "managedLink",
  observed_copy: "observedCopy",
  observed_link: "observedLink",
  shared_directory_read: "sharedDirectoryRead",
  shared_directory_reference: "sharedDirectoryReference",
  unknown: "unknown",
};
// G-18：外部变化状态码；`content_diverged` 是当前唯一登记状态。
const INSIGHTS_EXTERNAL_STATES: Record<string, string> = {
  content_diverged: "contentDiverged",
  unknown: "unknown",
};

function historyTranslation(key: string): string {
  return skillHubI18n.t(key as never) as string;
}

function insightsOperationLabel(messageCode: string): string {
  const prefix = "insights.operation.";
  const [rawCategory = "", rawOutcome = ""] = messageCode.startsWith(prefix)
    ? messageCode.slice(prefix.length).split(".")
    : [];
  const categoryKey = INSIGHTS_OPERATION_CATEGORIES[rawCategory];
  const outcomeKey = INSIGHTS_OPERATION_OUTCOMES[rawOutcome];
  const category = historyTranslation(
    "skillDetail.insights.historyMessages.categories."
      + (categoryKey ?? "unknown"),
  );
  const outcome = historyTranslation(
    "skillDetail.insights.historyMessages.outcomes."
      + (outcomeKey ?? "unknown"),
  );
  return `${category} · ${outcome}`;
}

function dependencyShapeLabel(shapeCode: string): string {
  const key = INSIGHTS_DEPENDENCY_SHAPES[shapeCode];
  // 未登记的新形态诚实回退原始码本身（是事实，不编造类型词）。
  return key
    ? historyTranslation(`skillDetail.insights.dependencyShapes.${key}`)
    : shapeCode;
}

function externalStateLabel(stateCode: string): string {
  const key = INSIGHTS_EXTERNAL_STATES[stateCode];
  return key
    ? historyTranslation(`skillDetail.insights.externalChangeStates.${key}`)
    : stateCode;
}

function unavailableResult(): SkillDetailUnavailableError {
  return new SkillDetailUnavailableError();
}

function asSkill(result: AppQueryResult): SkillResult {
  if (result.type !== "skill") throw unavailableResult();
  return result.payload;
}

function lifecycleOf(skill: SkillResult): SkillDetailSummary["lifecycle"] {
  if (skill.trial_due) return "trial";
  return skill.lifecycle === "Deprecated" ? "deprecated" : "active";
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
  // P1-10：别名（display_name）与原名（runtime_name）一致时不产生冗余别名；
  // 头部别名行绝不回退到裸 SkillId（DEV-15/DEV-16）。
  const aliased = skill.display_name !== skill.runtime_name;
  return {
    agentDeploymentCount: skill.agent_deployment_count,
    aiCheck: "not_run",
    alias: aliased ? skill.display_name : undefined,
    basicCheck: "not_run",
    // QA-010：概览展示后端推导的可读标签，内容哈希不进入展示层。
    currentVersion: skill.current_version_label ?? "unknown",
    currentVersionId: skill.current_version ?? undefined,
    highRiskCount: skill.high_risk_count,
    id: skill.skill_id,
    lifecycle: lifecycleOf(skill),
    // G-16：关系构成的真实计数（托管链接/独立副本）；后端未提供时保持缺省，
    // 界面显示"未知"而不是伪造 0。
    managedLinkCount: skill.managed_link_count,
    independentCopyCount: skill.independent_copy_count,
    // W3-1：安全预警投影原样透传（null=放行或已完全信任），与列表同源不另行推断。
    securityAlert: skill.security_alert ?? null,
    name: skill.display_name,
    pendingCount: skill.pending_count,
    projectDeploymentCount: skill.project_deployment_count,
    // P1-12：概览是全页唯一的用途陈述（头部不再重复）。口径：用户用途优先
    // （QA-008），缺省回退持久化译文，再回退原文，绝不留空。
    purpose: skill.user_purpose ?? skill.translated_description ?? skill.original_description,
    // K9：真实物化根目录（可见树）；树未物化时后端给 null，缺省即未知。
    rootPath: skill.root_path ?? undefined,
    // K5：上游“复用修改”谱系直传；未登记（字段缺失或 null）时缺省，不伪造来源。
    upstreamLineage: skill.upstream_lineage ?? undefined,
    trialDue: skill.trial_due ?? undefined,
    upgradeAvailable: skill.upstream_state == null
      ? undefined
      : skill.upstream_state === "update_available"
        || skill.upstream_state === "update_available_with_local_changes",
  };
}

// 2026-10-05 枚举定稿：与列表共用同一条派生规则（shared/checkState）；
// 检查读模型失联时如实降级为 unavailable 徽标，不拖垮整个概要查询。
async function checkState(
  skillId: string,
  versionId: string,
  kind: "basic" | "llm",
): Promise<SkillDetailSummary["basicCheck"]> {
  try {
    const result = await queryApplication(
      kind === "basic"
        ? { type: "get_basic_check_result", payload: { skill_id: skillId, version_id: versionId } }
        : { type: "get_llm_safety_check_result", payload: { skill_id: skillId, version_id: versionId } },
    );
    const expectedType = kind === "basic" ? "basic_check_result" : "llm_safety_check_result";
    if (result.type !== expectedType) return "unavailable";
    return checkStateOf(result.payload.state);
  } catch {
    return "unavailable";
  }
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
    invocationPolicy: skill.invocation_policy
      ? {
          mode: skill.invocation_policy.mode,
          source: skill.invocation_policy.source,
          field: skill.invocation_policy.field ?? undefined,
        }
      : undefined,
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

/** QA-008：把用户改动映射成原生的字段级 patch，避免并发编辑覆盖其他字段。 */
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
  const nativePatch: NativeSkillMetadataPatch = {};
  if (patch.alias !== undefined) nativePatch.display_name = patch.alias?.trim() || null;
  if (patch.note !== undefined) nativePatch.note = patch.note || null;
  if (patch.tags !== undefined) nativePatch.tags = patch.tags;
  if (patch.purpose !== undefined) nativePatch.user_purpose = patch.purpose || null;

  if (Object.keys(nativePatch).length === 0) return;
  const result: AppCommandResult = await executeCommand({
    type: "patch_skill_metadata",
    payload: { skill_id: skillId, patch: nativePatch },
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
    // AR-021：原生契约的 label 就是用户显式命名的版本名。此前这里只按序号
    // 生成展示标签、且从不填 userLabel，导致"命名版本"命令虽然写库成功，
    // 界面上却永远看不到名字。展示标签的优先级按契约执行：
    // 用户命名 → vN 序号 → 短哈希。
    const named = version.label?.trim() ? version.label.trim() : undefined;
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
      label: named ?? (sequence !== null ? `v${sequence}` : shortHash(version.version_id)),
      sequence,
      userLabel: named,
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
  // DEV-22-A：关系行的 target_id 可能是物理目标 id，逻辑/物理双键回查。
  const targets = targetsResult.type === "deployment_targets"
    ? indexTargetsByAnyId(targetsResult.payload)
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

/** K6：取得来源更新候选预览（preview_id + 文件级变化）。 */
async function prepareSourceUpdate(skillId: string): Promise<SourceUpdatePreview> {
  const result = await executeCommand({
    type: "prepare_source_update",
    payload: { skill_id: skillId },
  });
  if (result.type !== "source_update_preview") throw unavailableResult();
  return result.payload;
}

/** K6：提交用户决定；唯一合法采纳路径是 Preview→Commit 绑定。 */
async function commitSourceUpdate(
  previewId: string,
  decision: UpdateDecision,
): Promise<AppliedSourceUpdate> {
  const result = await executeCommand({
    type: "commit_source_update",
    payload: { preview_id: previewId, decision },
  });
  if (result.type !== "applied_source_update") throw unavailableResult();
  return result.payload;
}

/** K6/D3：按候选身份忽略当前候选；幂等命令，关闭界面绝不调用。 */
async function ignoreSourceUpdate(skillId: string, candidateIdentity: string): Promise<void> {
  const result = await executeCommand({
    type: "ignore_source_update",
    payload: { skill_id: skillId, candidate_identity: candidateIdentity },
  });
  if (result.type !== "operation_summary") throw unavailableResult();
}

/** K6：读取持久化的检查/忽略状态；从未检查过是 state=null 的诚实缺省。 */
async function getSourceUpdateStatus(skillId: string): Promise<SourceUpdateStatus> {
  const result = await queryApplication({
    type: "get_source_update_status",
    payload: { skill_id: skillId },
  });
  if (result.type !== "source_update_status") throw unavailableResult();
  return result.payload;
}

/** G-15：来源类型由调用方（界面）显式选择，这里只做规范化与透传。 */
async function relinkSource(skillId: string, sourceInput: SourceRelinkInput) {  const value = sourceInput.value.trim();
  const locator = sourceInput.kind === "https"
    ? { https_url: value }
    : sourceInput.kind === "git"
      ? { git_url: value }
      : { local_path: value };
  const result = await executeCommand({
    type: "relink_source",
    payload: { skill_id: skillId, source: { kind: sourceInput.kind, locator } },
  });
  if (result.type !== "operation_summary") throw unavailableResult();
  return { messageCode: result.payload.message_code };
}

export const nativeSkillDetailFacade: SkillDetailFacade = {
  ...unavailableSkillDetailFacade,
  checkSourceUpdate,
  prepareSourceUpdate,
  commitSourceUpdate,
  ignoreSourceUpdate,
  getSourceUpdateStatus,
  relinkSource,
  analyzeSemanticDuplicates: analyzeNativeSemanticDuplicates,
  isAiAvailable: isNativeAiAvailable,
  analyzeConflicts: analyzeNativeConflicts,
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
      return { text: result.payload.text };
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
  setTrial: setNativeTrial,
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
  async getRequirements(skillId) {
    const skill = await getSkill(skillId);
    return (skill.declared_requirements ?? []).map((requirement) => ({
      declaration: requirement.source,
      id: `${requirement.kind}:${requirement.name}`,
      name: requirement.version
        ? `${requirement.name} ${requirement.version}`
        : requirement.name,
      verification: "declared_only" as const,
    }));
  },
  saveMetadata,
  async getProvenance(skillId): Promise<SkillProvenance> {
    // OPT-20260914-08：溯源与已观察关系是纯展示/审计查询，绝不触发
    // 扫描、导入或任何文件系统写入；非导入链路的 Skill 诚实返回空。
    const result = await queryApplication({
      type: "get_skill_provenance",
      payload: { skill_id: skillId },
    });
    if (result.type !== "skill_provenance") throw unavailableResult();
    const provenance: SkillImportProvenance | null = result.payload.provenance
      ? {
          agentClientId: result.payload.provenance.agent_client_id,
          originalPath: result.payload.provenance.original_path,
          ownership: result.payload.provenance.ownership,
          sourceKind: result.payload.provenance.source.kind,
          sourceLocator:
            result.payload.provenance.source.locator.local_path ??
            result.payload.provenance.source.locator.https_url ??
            result.payload.provenance.source.locator.git_url ??
            "",
          contentFingerprint: result.payload.provenance.content_fingerprint,
          importedAt: result.payload.provenance.imported_at,
        }
      : null;
    const observedDeployments: SkillObservedDeployment[] =
      result.payload.observed_deployments.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        originalPath: row.original_path,
        contentFingerprint: row.content_fingerprint,
        matchState: row.match_state,
        origin: row.origin,
        status: row.status,
        observedAt: row.observed_at,
        releasedAt: row.released_at,
      }));
    return { provenance, observedDeployments };
  },
  async getRelations(skillId): Promise<SkillRelation[]> {
    const relationsResult = await queryApplication({
      type: "get_deployment_relations",
      payload: { skill_id: skillId },
    });
    if (relationsResult.type !== "deployment_relations") throw unavailableResult();
    const targetsResult = await queryApplication({ type: "list_deployment_targets", payload: null });
    if (targetsResult.type !== "deployment_targets") throw unavailableResult();
    // DEV-22-A：关系行的 target_id 可能是物理目标 id，逻辑/物理双键回查。
    const targets = indexTargetsByAnyId(targetsResult.payload);
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
        agentClientId: target?.agent_client_id ?? undefined,
        agentProfileId: target?.agent_profile_id ?? undefined,
        sharedDirectory: target?.shared_directory,
      };
    });
  },
  async getRelationshipOverview(skillId) {
    // Task 7：Skill 维度的关系事实只来自统一关系 DTO（typed facade，只读）。
    const result = await queryApplication({
      type: "get_relationship_overview",
      payload: { scope: { type: "skill", value: { skill_id: skillId } } },
    });
    if (result.type !== "relationship_overview") throw unavailableResult();
    return result.payload;
  },
  async getRelationshipRemovalImpact(relationId) {
    const result = await queryApplication({
      type: "get_relationship_removal_impact",
      payload: { relation_id: relationId },
    });
    if (result.type !== "relationship_removal_impact") throw unavailableResult();
    return result.payload;
  },
  async getInsights(skillId): Promise<SkillDetailInsights> {
    // G-18：组合/依赖/外部变化/操作历史来自 get_skill_insights 读模型；
    // 确定性重复候选仍来自既有 list_deterministic_duplicates 查询。
    const [insightsResult, duplicatesResult] = await Promise.all([
      queryApplication({
        type: "get_skill_insights",
        payload: { skill_id: skillId },
      }),
      queryApplication({
        type: "list_deterministic_duplicates",
        payload: { skill_id: skillId },
      }),
    ]);
    if (insightsResult.type !== "skill_insights") throw unavailableResult();
    if (duplicatesResult.type !== "deterministic_duplicates") throw unavailableResult();
    const payload = insightsResult.payload;
    const insights: SkillDetailInsights = {
      combinations: payload.combinations.map((combination) => ({
        name: combination.name,
        otherMemberLabels: [...combination.other_member_labels],
      })),
      dependencies: payload.dependencies.map((dependency) => ({
        agentClientId: dependency.agent_client_id,
        id: dependency.relation_id,
        path: dependency.path,
        shapeLabel: dependencyShapeLabel(dependency.shape_code),
      })),
      deterministicDuplicates: duplicatesResult.payload.map((entry) => entry.label),
      externalChanges: payload.external_changes.map((change) => ({
        id: change.relation_id,
        path: change.path,
        stateLabel: externalStateLabel(change.state_code),
      })),
      // Unix 秒（十进制字符串）在前端本地化；不可得时诚实缺省时间。
      operationHistory: payload.operation_history.map((entry) => ({
        at: entry.at_epoch
          ? new Date(Number(entry.at_epoch) * 1000).toLocaleString()
          : undefined,
        id: entry.operation_id,
        label: insightsOperationLabel(entry.message_code),
      })),
    };
    if (payload.operation_history_limitation) {
      insights.operationHistoryLimitation = payload.operation_history_limitation;
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

/** Task 8：AI 可用性真实信号——与设置页同一供应商列表；是否可用由
 * usableLlmProviderLabel 判定（已启用 + 本地或凭据已配置）。 */
export async function isNativeAiAvailable(): Promise<boolean> {
  const result = await queryApplication({ type: "list_llm_providers" });
  if (result.type !== "llm_providers") throw unavailableResult();
  return usableLlmProviderLabel(result.payload) !== "";
}

/** Task 8：Skill 维度的可选冲突分析。结果是建议性短结论，绝不改变用户裁决。 */
export async function analyzeNativeConflicts(
  scope: AnalyzeConflictScope,
): Promise<ConflictAnalysis> {
  const result: AppCommandResult = await executeCommand({
    type: "analyze_conflict",
    payload: { scope },
  });
  if (result.type !== "conflict_analysis") throw unavailableResult();
  return result.payload;
}

/** Switches the catalog pointer to an existing version. The backend requires a
 * single-use preview binding, so the real flow is preview first, then commit. */
export async function setNativeCurrentVersion(
  skillId: string,
  versionId: string,
): Promise<void> {
  const previewResult = await queryApplication({
    type: "get_rollback_impact",
    payload: { skill_id: skillId, target_version_id: versionId },
  });
  if (previewResult.type !== "rollback_impact") throw unavailableResult();
  const result: AppCommandResult = await executeCommand({
    type: "set_current_version",
    payload: {
      skill_id: skillId,
      version_id: versionId,
      preview_id: previewResult.payload.preview_id,
    },
  });
  if (result.type !== "operation_summary") throw unavailableResult();
}

/** 原生契约用 `[年, 月, 日]` 元组表达复核日期；`null` 表示清除试用。 */
function trialDueTuple(due: string | null): [number, number, number] | null {
  if (due === null || due.trim() === "") return null;
  const parts = due.split("-").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw unavailableResult();
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * 设置或清除试用复核日期。
 *
 * 这是详情页试用区唯一的写入入口：很长一段时间里它只有 `unavailable` 兜底
 * （生产装配从未提供 `setTrial`），用户在真实应用里点保存必然失败，而
 * 命令级审计看不到它——审计统计的是 `executeCommand` 调用点，而这里当时
 * 根本没有调用点。
 */
export async function setNativeTrial(skillId: string, due: string | null): Promise<void> {
  const result: AppCommandResult = await executeCommand({
    type: "set_trial",
    payload: { skill_id: skillId, due: trialDueTuple(due) },
  });
  if (result.type !== "operation_summary") throw unavailableResult();
}
