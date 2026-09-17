import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ConflictCaseFact } from "../../api/bindings";
import { Button } from "../../ui/Button";
import { conflictWorkspaceHref } from "../relationships/decisions/conflictDecisions";
import {
  actionForMember,
  conflictClassificationLabelKey,
  type ImportGovernanceAction,
  type ImportGovernanceDecision,
  type ImportGovernanceGroup,
} from "./relationshipGovernance";

export interface RelationshipGovernancePanelProps {
  groups: ImportGovernanceGroup[];
  decision?: ImportGovernanceDecision;
  aiAvailable?: boolean;
  onDecision: (decision: ImportGovernanceDecision) => void;
  /** 任务 7：持久化冲突组的确定性事实；AI 分析与裁决集中在冲突处理工作台。 */
  conflictCases?: ConflictCaseFact[];
}

const actionKeys: Record<ImportGovernanceAction, string> = {
  preserve_original: "importWorkflow.governance.actions.preserveOriginal",
  create_todo: "importWorkflow.governance.actions.createTodo",
};

const classificationKeys: Record<ImportGovernanceGroup["classification"], string> = {
  exact_duplicate: "importWorkflow.governance.classification.exactDuplicate",
  content_identical_copy: "importWorkflow.governance.classification.contentIdenticalCopy",
  same_name_different_content:
    "importWorkflow.governance.classification.sameNameDifferentContent",
  shared_directory_read: "importWorkflow.governance.classification.sharedDirectoryRead",
  shared_directory_reference:
    "importWorkflow.governance.classification.sharedDirectoryReference",
  unrecognized_source: "importWorkflow.governance.classification.unrecognizedSource",
};

const rollbackKeys: Record<ImportGovernanceGroup["classification"], string> = {
  exact_duplicate: "importWorkflow.governance.rollback.exact_duplicate",
  content_identical_copy: "importWorkflow.governance.rollback.content_identical_copy",
  same_name_different_content:
    "importWorkflow.governance.rollback.same_name_different_content",
  shared_directory_read: "importWorkflow.governance.rollback.shared_directory_read",
  shared_directory_reference:
    "importWorkflow.governance.rollback.shared_directory_reference",
  unrecognized_source: "importWorkflow.governance.rollback.unrecognized_source",
};

/** 导入冲突组的确定性摘要（任务 7 清理后）：只列事实与工作台深链，
 * 不再自带 AI 冲突分析入口或结论渲染——那属于冲突处理工作台。 */
function ConflictCasesSummary({
  cases,
}: {
  cases: ConflictCaseFact[];
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="conflict-cases-heading"
      className="sh-conflict-analysis"
      data-testid="conflict-cases-section"
    >
      <h3 id="conflict-cases-heading">
        {t("relationships.decisions.panelHeading")}
      </h3>
      <ul>
        {cases.map((conflict) => (
          <li key={conflict.conflict_id}>
            <strong>{conflict.conflict_id}</strong>
            <span>
              {t(conflictClassificationLabelKey(conflict.classification) as never)}
            </span>
            {(conflict.members ?? []).map((member) =>
              member.path ? <code key={member.path}>{member.path}</code> : null,
            )}
            <Link to={conflictWorkspaceHref(conflict.conflict_id)}>
              {t("relationships.decisions.deepLink.label")}
            </Link>
          </li>
        ))}
      </ul>
      <p className="sh-settings-local-note">
        {t("relationships.decisions.deepLink.hint")}
      </p>
    </section>
  );
}

/** 组级影响事实全部由成员聚合而来；后端不产出界面散文。 */
function affectedAgentsOfGroup(group: ImportGovernanceGroup): string[] {
  return [...new Set(group.members.flatMap((member) => member.affected_agents))];
}

/**
 * 可复用的关系治理确认面板。它只消费后端给出的确定性分类与影响摘要，
 * 不根据路径、候选名或 AI 输出重新推断关系。
 */
export function RelationshipGovernancePanel({
  aiAvailable = true,
  conflictCases,
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
      {conflictCases && conflictCases.length > 0 ? (
        <ConflictCasesSummary cases={conflictCases} />
      ) : null}
      {groups.map((group) => {
        const agents = affectedAgentsOfGroup(group);
        const agentSummary = agents.length > 0
          ? agents.join(t("importWorkflow.governance.impact.agentSeparator") as never)
          : String(t("importWorkflow.governance.impact.noKnownAgent") as never);
        return (
        <article key={group.group_id}>
          <h3>{t(classificationKeys[group.classification] as never)}</h3>
          <p>
            {t("importWorkflow.governance.impact.summary", {
              agents: agentSummary,
              count: group.members.length,
            })}
          </p>
          <p>{t(rollbackKeys[group.classification] as never)}</p>
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
                  <span>{t("importWorkflow.governance.impact.sourcePathLabel", { path: member.source_path })}</span>
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
        );
      })}
    </section>
  );
}
