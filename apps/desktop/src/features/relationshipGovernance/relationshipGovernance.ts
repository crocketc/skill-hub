export type ImportGovernanceClassification =
  | "shared_directory"
  | "managed_relation"
  | "source_preservation";

export type ImportGovernanceAction =
  | "keep_original"
  | "create_todo"
  | "convert_to_managed_link";

export interface ImportGovernanceMember {
  candidateId: string;
  name: string;
  detail: string;
}

/** 后端确定性关系分析的前端投影；AI 只能附加建议，不能改变这里的动作。 */
export interface ImportGovernanceGroup {
  id: string;
  classification: ImportGovernanceClassification;
  members: ImportGovernanceMember[];
  impactSummary: string;
  defaultAction: ImportGovernanceAction;
  availableActions: ImportGovernanceAction[];
}

/** 分组动作与逐项覆盖一起提交；逐项覆盖优先。 */
export interface ImportGovernanceDecision {
  groupActions: Record<string, ImportGovernanceAction>;
  itemOverrides: Record<string, ImportGovernanceAction>;
}

export function actionForMember(
  group: ImportGovernanceGroup,
  decision: ImportGovernanceDecision,
  memberId: string,
): ImportGovernanceAction {
  return decision.itemOverrides[memberId]
    ?? decision.groupActions[group.id]
    ?? group.defaultAction;
}
