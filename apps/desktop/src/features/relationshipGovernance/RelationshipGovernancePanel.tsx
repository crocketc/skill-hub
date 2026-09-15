import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import {
  actionForMember,
  type ImportGovernanceAction,
  type ImportGovernanceDecision,
  type ImportGovernanceGroup,
} from "./relationshipGovernance";

export interface RelationshipGovernancePanelProps {
  groups: ImportGovernanceGroup[];
  decision?: ImportGovernanceDecision;
  aiAvailable?: boolean;
  onDecision: (decision: ImportGovernanceDecision) => void;
}

const actionKeys: Record<ImportGovernanceAction, string> = {
  preserve_original: "importWorkflow.governance.actions.preserveOriginal",
  create_todo: "importWorkflow.governance.actions.createTodo",
};

const classificationKeys: Record<ImportGovernanceGroup["classification"], string> = {
  source_preservation: "importWorkflow.governance.classification.sourcePreservation",
  agent_managed_source: "importWorkflow.governance.classification.agentManagedSource",
  conflict_follow_up: "importWorkflow.governance.classification.conflictFollowUp",
};

/**
 * 可复用的关系治理确认面板。它只消费后端给出的确定性分类与影响摘要，
 * 不根据路径、候选名或 AI 输出重新推断关系。
 */
export function RelationshipGovernancePanel({
  aiAvailable = true,
  decision = { group_actions: {}, item_overrides: {} },
  groups,
  onDecision,
}: RelationshipGovernancePanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const selectGroup = (group: ImportGovernanceGroup, action: ImportGovernanceAction) => {
    onDecision({
      group_actions: { ...decision.group_actions, [group.group_id]: action },
      item_overrides: decision.item_overrides,
    });
  };
  const selectMember = (memberId: string, action: ImportGovernanceAction) => {
    onDecision({
      group_actions: decision.group_actions,
      item_overrides: { ...decision.item_overrides, [memberId]: action },
    });
  };

  return (
    <section aria-labelledby="relationship-governance-title" className="sh-relationship-governance" id="relationship-governance">
      <header>
        <p>{t("importWorkflow.governance.eyebrow")}</p>
        <h2 id="relationship-governance-title">{t("importWorkflow.governance.title")}</h2>
        <p>{t("importWorkflow.governance.description")}</p>
      </header>
      {!aiAvailable ? <p role="status">{t("importWorkflow.governance.aiUnavailable")}</p> : null}
      {groups.map((group) => (
        <article key={group.group_id}>
          <h3>{t(classificationKeys[group.classification] as never)}</h3>
          <p>{group.impact_summary}</p>
          <fieldset>
            <legend>{t("importWorkflow.governance.groupActionLegend")}</legend>
            {group.available_actions.map((action) => (
              <label key={action}>
                <input
                  checked={decision.group_actions[group.group_id] === action}
                  name={`group-${group.group_id}`}
                  onChange={() => selectGroup(group, action)}
                  type="radio"
                />
                {t(actionKeys[action] as never)}
              </label>
            ))}
          </fieldset>
          <Button
            aria-expanded={Boolean(expanded[group.group_id])}
            onClick={() => setExpanded((current) => ({ ...current, [group.group_id]: !current[group.group_id] }))}
            variant="ghost"
          >
            {expanded[group.group_id]
              ? t("importWorkflow.governance.collapseMembers")
              : t("importWorkflow.governance.expandMembers", { count: group.members.length })}
          </Button>
          {expanded[group.group_id] ? (
            <ul>
              {group.members.map((member) => (
                <li key={member.member_id}>
                  <strong>{member.display_name}</strong>
                  <fieldset>
                    <legend>{t("importWorkflow.governance.memberOverrideLegend", { name: member.display_name })}</legend>
                    {group.available_actions.map((action) => (
                      <label key={action}>
                        <input
                          checked={actionForMember(group, decision, member.member_id) === action}
                          name={`member-${member.member_id}`}
                          onChange={() => selectMember(member.member_id, action)}
                          type="radio"
                        />
                        {t("importWorkflow.governance.memberActionLabel", {
                          action: t(actionKeys[action] as never),
                          name: member.display_name,
                        })}
                      </label>
                    ))}
                  </fieldset>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
    </section>
  );
}
