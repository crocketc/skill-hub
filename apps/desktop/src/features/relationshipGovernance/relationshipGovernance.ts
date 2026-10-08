import type {
  ConflictClassification,
  DirectoryPrecedence,
  DirectoryRecognition,
  DirectoryRole,
  FileRepresentation,
  GovernanceTaskFact,
  GovernanceTaskKind,
  ImportGovernanceAction,
  ImportGovernanceDecision,
  ImportGovernanceGroup,
  MinimalImpactAction,
  ObservedMatchState,
  OwnershipState,
  RelationshipOverview,
  RelationshipType,
  SourceRelationFact,
  RelationGovernanceRow,
  UsageRelationView,
} from "../../api/bindings";
import { relationIdOf } from "../relationships/governance/api";

export type {
  ImportGovernanceAction,
  ImportGovernanceDecision,
  ImportGovernanceGroup,
};

/**
 * Task 7：Agent 页目录矩阵与 Skill 详情关系区共用的确定性视图模型。
 * 所有函数只重排/聚合 typed facade 事实（RelationshipOverview），
 * 不推断"已加载/一定会调用"，也不访问 bindings 之外的层。
 */

export type { ConflictClassification, DirectoryPrecedence, DirectoryRecognition, DirectoryRole, FileRepresentation, GovernanceTaskKind, MinimalImpactAction, ObservedMatchState, OwnershipState, RelationshipOverview, RelationshipType, SourceRelationFact };

export type UsageGovernanceActionRestriction =
  | "missing_subject"
  | "entry_identity_unavailable"
  | "identity_conflict"
  | "incomplete_evidence"
  | "multiple_targets"
  | "shared_impact";

/** A unified active usage fact with legacy rows retained only as action context. */
export interface UsageGovernanceRow {
  usage: UsageRelationView;
  evidenceRows: RelationGovernanceRow[];
  actionRow: RelationGovernanceRow | null;
  actionRestriction: UsageGovernanceActionRestriction | null;
  actionContextState: "ready" | "loading" | "unavailable";
}

export function projectActiveUsageRelations(
  views: readonly UsageRelationView[],
): UsageRelationView[] {
  return views.filter((view) => view.active && view.decision === null);
}

export function classifyUsageRelation(
  view: UsageRelationView,
): "pending" | "no_action" | null {
  if (!view.active || view.decision !== null) return null;
  const healthy = view.health_reasons.length === 1 && view.health_reasons[0] === "normal";
  const builtinOriginal = view.target.directory_role === "builtin";
  return healthy && (view.management === "managed" || builtinOriginal)
    ? "no_action"
    : "pending";
}

/**
 * Join each unified fact to all of its legacy evidence rows. A mutating action
 * is available only for one complete, identity-matched bottom-level row.
 */
export function projectUsageGovernanceRows(
  views: readonly UsageRelationView[],
  legacyRows: readonly RelationGovernanceRow[],
  actionContextState: UsageGovernanceRow["actionContextState"] = "ready",
): UsageGovernanceRow[] {
  return projectActiveUsageRelations(views).map((usage) => {
    if (actionContextState !== "ready") {
      return { usage, evidenceRows: [], actionRow: null, actionRestriction: null, actionContextState };
    }
    const expectedIds = new Set(usage.evidence_relation_ids.filter(Boolean));
    const evidenceRows = legacyRows.filter((row) => {
      const rowIds = new Set([...row.evidence_relation_ids, relationIdOf(row.relation)]);
      return [...rowIds].some((id) => expectedIds.has(id));
    });
    let actionRestriction: UsageGovernanceActionRestriction | null = null;
    let actionRow: RelationGovernanceRow | null = null;

    if (usage.skill_id === null) {
      actionRestriction = "missing_subject";
    } else if (usage.entry_key === null) {
      actionRestriction = "entry_identity_unavailable";
    } else if (
      new Set(usage.physical_source_ids_evidence).size > 1
    ) {
      actionRestriction = "identity_conflict";
    } else if (expectedIds.size === 0 || evidenceRows.length === 0) {
      actionRestriction = "incomplete_evidence";
    } else {
      const coveredIds = new Set<string>();
      let hasExtraEvidence = false;
      for (const row of evidenceRows) {
        const rowIds = new Set([...row.evidence_relation_ids, relationIdOf(row.relation)]);
        for (const id of rowIds) {
          if (expectedIds.has(id)) coveredIds.add(id);
          else hasExtraEvidence = true;
        }
      }
      const complete = !hasExtraEvidence
        && coveredIds.size === expectedIds.size
        && [...expectedIds].every((id) => coveredIds.has(id));
      if (!complete) {
        actionRestriction = "incomplete_evidence";
      } else if (expectedIds.size !== 1 || evidenceRows.length !== 1) {
        actionRestriction = "multiple_targets";
      } else {
        const onlyId = [...expectedIds][0]!;
        const row = evidenceRows[0]!;
        const fact = row.relation.fact;
        const rowSkillId = fact.skill_id;
        const rowDirectoryId = fact.directory_node_id;
        const rowEvidenceIds = new Set(row.evidence_relation_ids);
        if (
          rowSkillId !== usage.skill_id
          || rowDirectoryId !== usage.target.directory_id
          || relationIdOf(row.relation) !== onlyId
          || rowEvidenceIds.size !== 1
          || !rowEvidenceIds.has(onlyId)
        ) {
          actionRestriction = "identity_conflict";
        } else if (
          usage.target.kind === "shared_directory"
          || usage.target.directory_role === "shared_directory"
          || row.impact.other_consumer_agent_ids.length > 0
          || row.impact.other_skill_paths.length > 0
        ) {
          actionRestriction = "shared_impact";
          // A unique, complete bottom-level target may still be opened in the
          // existing impact preview. The preview owns explicit confirmation;
          // only ambiguous/multiple identities lose their action context.
          actionRow = row;
        } else {
          actionRow = row;
        }
      }
    }

    return { usage, evidenceRows, actionRow, actionRestriction, actionContextState };
  });
}

export function usageGovernanceRowId(row: UsageGovernanceRow): string {
  return row.usage.relation_id;
}

/** Legacy commands target the exact bottom-level relation, never the aggregate representative ID. */
export function usageGovernanceActionRelationId(row: UsageGovernanceRow): string {
  return row.actionRow ? relationIdOf(row.actionRow.relation) : usageGovernanceRowId(row);
}

export function usageGovernanceRowIsSelectable(row: UsageGovernanceRow): boolean {
  const actionRow = row.actionRow;
  const centralizeCondition = actionRow?.governance.action_conditions.find(
    (condition) => condition.action === "centralize_management",
  );
  const sharedImpactOnlyConfirmation = Boolean(
    centralizeCondition
      && !centralizeCondition.available
      && centralizeCondition.reasons.length > 0
      && centralizeCondition.reasons.every((reason) => reason === "shared_impact_confirmation_required"),
  );
  return classifyUsageRelation(row.usage) === "pending"
    && row.actionContextState === "ready"
    && actionRow?.relation.kind === "deployment"
    && (centralizeCondition?.available === true || sharedImpactOnlyConfirmation);
}

/** 用户可执行的动作入口；Task 7 只提供影响预览，不内置转换执行。 */
export type RelationshipViewAction = "view_removal_impact";

export interface RelationshipView {
  relationId: string;
  skillId: string | null;
  directoryNodeId: string | null;
  targetAgentClientId: string;
  path: string;
  relationship: RelationshipType;
  fileRepresentation: FileRepresentation;
  ownership: OwnershipState;
  fingerprintState: ObservedMatchState;
  /** 链接目标（如通用共享目录中的本体路径）；非链接关系为 null。 */
  linkTargetPath: string | null;
  linkTargetDirectoryId: string | null;
  active: boolean;
  actions: RelationshipViewAction[];
  pendingTaskIds: string[];
}

export interface AgentDirectoryView {
  directoryNodeId: string;
  path: string;
  role: DirectoryRole;
  exists: boolean;
  /** null 表示该 Agent 尚未登记此目录的识别能力：诚实缺省，不推断。 */
  recognition: DirectoryRecognition | null;
  precedence: DirectoryPrecedence | null;
  evidenceReference: string | null;
  researchedAt: string | null;
  applicablePlatforms: string[];
  skillCount: number;
  sharedConsumers: string[];
  relations: RelationshipView[];
}

export interface SkillRelationshipViews {
  sources: SourceRelationFact[];
  deployments: RelationshipView[];
  conflicts: RelationshipOverview["conflict_cases"];
  pendingTasks: RelationshipOverview["pending_governance_tasks"];
}

/** 用户层关系标签：managed_link="链接部署"、managed_copy="复制部署"；无"外部链接"。 */
export function relationshipLabelKey(relationship: RelationshipType): string {
  return `relationshipGovernance.relationship.${relationship}`;
}

/** 技术详情标签：符号链接/目录联接等只出现在技术详情，不替代用户层关系标签。 */
export function fileRepresentationLabelKey(representation: FileRepresentation): string {
  return `relationshipGovernance.fileRepresentation.${representation}`;
}

export function ownershipLabelKey(ownership: OwnershipState): string {
  return `relationshipGovernance.ownership.${ownership}`;
}

export function fingerprintLabelKey(state: ObservedMatchState): string {
  return `relationshipGovernance.fingerprint.${state}`;
}

export function recognitionLabelKey(recognition: DirectoryRecognition | null): string {
  return recognition
    ? `relationshipGovernance.recognition.${recognition}`
    : "relationshipGovernance.recognition.unregistered";
}

export function directoryRoleLabelKey(role: DirectoryRole): string {
  return `relationshipGovernance.directoryRole.${role}`;
}

export function precedenceLabelKey(precedence: DirectoryPrecedence): string {
  return `relationshipGovernance.precedence.${precedence}`;
}

export function minimalImpactActionLabelKey(action: MinimalImpactAction): string {
  return `relationshipGovernance.minimalAction.${action}`;
}

export function governanceTaskKindLabelKey(kind: GovernanceTaskKind): string {
  return `relationshipGovernance.governanceTaskKind.${kind}`;
}

export function conflictClassificationLabelKey(classification: ConflictClassification): string {
  return `relationshipGovernance.conflictClassification.${classification}`;
}

export function toRelationshipView(
  relation: RelationshipOverview["deployment_relations"][number],
  tasks: readonly GovernanceTaskFact[],
): RelationshipView {
  return {
    relationId: relation.relation_id,
    skillId: relation.skill_id,
    directoryNodeId: relation.directory_node_id,
    targetAgentClientId: relation.agent_client_id,
    path: relation.path,
    relationship: relation.relationship,
    fileRepresentation: relation.file_representation,
    ownership: relation.ownership,
    fingerprintState: relation.match_state,
    linkTargetPath: relation.link_target_path,
    linkTargetDirectoryId: relation.link_target_directory_id,
    active: relation.active,
    // 活动关系至少有移除影响入口；非活动（已收回）关系不提供动作。
    actions: relation.active ? ["view_removal_impact"] : [],
    pendingTaskIds: tasks
      .filter((task) => task.subject_id === relation.relation_id && !task.resolved)
      .map((task) => task.task_id),
  };
}

const roleOrder: Record<DirectoryRole, number> = {
  shared_directory: 0,
  agent_native: 1,
  project: 2,
  central_library: 3,
};

export function buildAgentDirectoryViews(
  overview: RelationshipOverview,
  options: { currentAgentClientId?: string } = {},
): AgentDirectoryView[] {
  const currentAgent = options.currentAgentClientId;
  const tasks = overview.pending_governance_tasks;
  const views = overview.directory_nodes.map((node) => {
    const capability = overview.agent_directory_capabilities.find(
      (row) => row.directory_node_id === node.node_id
        && (currentAgent === undefined || row.agent_client_id === currentAgent),
    );
    const relations = overview.deployment_relations
      .filter((relation) => relation.directory_node_id === node.node_id)
      .map((relation) => toRelationshipView(relation, tasks));
    const consumers = new Set<string>();
    // 设计 §2.1：unknown 是"尚未确认"，unsupported 是"已有证据不支持"。
    // 都不得从目录存在推断为消费者；只有 supported 的登记能力计入。
    for (const row of overview.agent_directory_capabilities) {
      if (row.directory_node_id === node.node_id && row.recognition === "supported") {
        consumers.add(row.agent_client_id);
      }
    }
    for (const relation of overview.deployment_relations) {
      if (relation.directory_node_id === node.node_id && relation.active) {
        consumers.add(relation.agent_client_id);
      }
    }
    if (currentAgent !== undefined) consumers.delete(currentAgent);
    return {
      directoryNodeId: node.node_id,
      path: node.path,
      role: node.role,
      exists: node.exists,
      recognition: capability?.recognition ?? null,
      precedence: capability?.precedence ?? null,
      evidenceReference: capability?.evidence_reference ?? null,
      researchedAt: capability?.researched_at ?? null,
      applicablePlatforms: capability?.applicable_platforms ?? [],
      // Skill 数按去重后的活动 Skill 计；非活动关系不计入。
      skillCount: new Set(
        overview.deployment_relations
          .filter((relation) => relation.directory_node_id === node.node_id && relation.active && relation.skill_id !== null)
          .map((relation) => relation.skill_id),
      ).size,
      sharedConsumers: [...consumers].sort(),
      relations,
    } satisfies AgentDirectoryView;
  });
  return views.sort((left, right) =>
    roleOrder[left.role] - roleOrder[right.role] || left.path.localeCompare(right.path));
}

export function buildSkillRelationshipViews(
  overview: RelationshipOverview,
): SkillRelationshipViews {
  const tasks = overview.pending_governance_tasks;
  return {
    sources: overview.source_relations,
    deployments: overview.deployment_relations.map((relation) => toRelationshipView(relation, tasks)),
    conflicts: overview.conflict_cases,
    pendingTasks: overview.pending_governance_tasks,
  };
}

export function actionForMember(
  group: ImportGovernanceGroup,
  decision: ImportGovernanceDecision,
  memberId: string,
): ImportGovernanceAction {
  return decision.item_overrides[memberId]
    ?? decision.group_actions[group.group_id]
    ?? group.default_action;
}

export function hasExplicitGovernanceConfirmation(
  groups: readonly ImportGovernanceGroup[],
  decision: ImportGovernanceDecision,
): boolean {
  return groups.every((group) => Boolean(decision.group_actions[group.group_id])
    || group.members.every((member) => Boolean(decision.item_overrides[member.member_id])));
}
