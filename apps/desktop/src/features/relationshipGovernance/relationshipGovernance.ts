import type {
  ImportGovernanceAction,
  ImportGovernanceDecision,
  ImportGovernanceGroup,
} from "../../api/bindings";

export type {
  ImportGovernanceAction,
  ImportGovernanceDecision,
  ImportGovernanceGroup,
};

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
