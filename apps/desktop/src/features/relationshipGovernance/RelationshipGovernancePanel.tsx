import { useState } from "react";
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

const actionLabels: Record<ImportGovernanceAction, string> = {
  keep_original: "原件保留",
  create_todo: "创建待办",
  convert_to_managed_link: "建立受管链接",
};

/**
 * 可复用的关系治理确认面板。它只消费后端给出的确定性分类与影响摘要，
 * 不根据路径、候选名或 AI 输出重新推断关系。
 */
export function RelationshipGovernancePanel({
  aiAvailable = true,
  decision = { groupActions: {}, itemOverrides: {} },
  groups,
  onDecision,
}: RelationshipGovernancePanelProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const selectGroup = (group: ImportGovernanceGroup, action: ImportGovernanceAction) => {
    onDecision({
      groupActions: { ...decision.groupActions, [group.id]: action },
      itemOverrides: decision.itemOverrides,
    });
  };
  const selectMember = (memberId: string, action: ImportGovernanceAction) => {
    onDecision({
      groupActions: decision.groupActions,
      itemOverrides: { ...decision.itemOverrides, [memberId]: action },
    });
  };

  return (
    <section aria-labelledby="relationship-governance-title" className="sh-relationship-governance" id="relationship-governance">
      <header>
        <p>关系治理</p>
        <h2 id="relationship-governance-title">确认导入后的关系处理</h2>
        <p>导入集中库与处理原始副本是独立操作；所有更改都需要确认、影响说明和回退路径。</p>
      </header>
      {!aiAvailable ? <p role="status">AI 建议未配置；已保留确定性关系判断。</p> : null}
      {groups.map((group) => (
        <article key={group.id}>
          <h3>{group.classification.replaceAll("_", " ")}</h3>
          <p>{group.impactSummary}</p>
          <fieldset>
            <legend>分组默认动作</legend>
            {group.availableActions.map((action) => (
              <label key={action}>
                <input
                  checked={(decision.groupActions[group.id] ?? group.defaultAction) === action}
                  name={`group-${group.id}`}
                  onChange={() => selectGroup(group, action)}
                  type="radio"
                />
                {actionLabels[action]}
              </label>
            ))}
          </fieldset>
          <Button
            aria-expanded={Boolean(expanded[group.id])}
            onClick={() => setExpanded((current) => ({ ...current, [group.id]: !current[group.id] }))}
            variant="ghost"
          >
            {expanded[group.id] ? "收起项目" : `展开 ${group.members.length} 个项目`}
          </Button>
          {expanded[group.id] ? (
            <ul>
              {group.members.map((member) => (
                <li key={member.candidateId}>
                  <strong>{member.name}</strong>
                  <p>{member.detail}</p>
                  <fieldset>
                    <legend>{member.name} 的单项覆盖</legend>
                    {group.availableActions.map((action) => (
                      <label key={action}>
                        <input
                          checked={actionForMember(group, decision, member.candidateId) === action}
                          name={`member-${member.candidateId}`}
                          onChange={() => selectMember(member.candidateId, action)}
                          type="radio"
                        />
                        {member.name}：{actionLabels[action]}
                      </label>
                    ))}
                  </fieldset>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
      <a href="#relationship-governance">前往关系治理待办</a>
    </section>
  );
}
