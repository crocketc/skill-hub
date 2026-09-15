import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import type {
  AnalyzeConflictScope,
  ConflictAnalysis,
  ConflictCaseFact,
  ConflictClassification,
} from "../../api/bindings";
import { Button } from "../../ui/Button";
import {
  actionForMember,
  conflictClassificationLabelKey,
  type ImportGovernanceAction,
  type ImportGovernanceDecision,
  type ImportGovernanceGroup,
} from "./relationshipGovernance";

/** Task 8：冲突组区的可选 AI 分析。宿主传入持久化冲突组（确定性事实）
 * 与分析回调；面板只展示事实与短结论，绝不据此改变用户裁决。 */
export interface GovernanceConflictAnalysis {
  /** 持久化冲突组事实；始终先于 AI 结论展示。 */
  cases: ConflictCaseFact[];
  /** 最近一次运行结果；尚未运行时缺省。 */
  result?: ConflictAnalysis;
  /** 运行中：按钮禁用，避免重复发起。 */
  running: boolean;
  onAnalyze: (scope: AnalyzeConflictScope) => void;
}

export interface RelationshipGovernancePanelProps {
  groups: ImportGovernanceGroup[];
  decision?: ImportGovernanceDecision;
  aiAvailable?: boolean;
  onDecision: (decision: ImportGovernanceDecision) => void;
  /** Task 8：可选冲突组 AI 分析区；宿主没有持久化冲突组时不传。 */
  conflictAnalysis?: GovernanceConflictAnalysis;
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

const recommendedActionKeys: Record<ConflictAnalysis["cases"][number]["recommended_action"], string> = {
  same_skill_version: "relationshipGovernance.conflictAnalysis.action.same_skill_version",
  distinct_skill: "relationshipGovernance.conflictAnalysis.action.distinct_skill",
  keep_uncertain: "relationshipGovernance.conflictAnalysis.action.keep_uncertain",
};

/** 冲突组 AI 分析区：确定性基线永远先于 AI 短结论，失败码可读可追踪。 */
function ConflictAnalysisSection({
  aiAvailable,
  conflictAnalysis,
}: {
  aiAvailable: boolean;
  conflictAnalysis: GovernanceConflictAnalysis;
}): JSX.Element {
  const { t } = useTranslation();
  const { cases, onAnalyze, result, running } = conflictAnalysis;
  const classifications = [
    ...new Set(cases.map((conflict) => conflict.classification)),
  ] as ConflictClassification[];
  const failureReason = result?.failure_code
    ? describeNativeError(
        { code: result.failure_code, severity: "error", params: {}, actions: [] },
        (key, options) => String(t(key as never, options as never)),
        "relationshipGovernance.conflictAnalysis.failureUnknown",
      )
    : null;

  return (
    <section
      aria-labelledby="conflict-analysis-heading"
      className="sh-conflict-analysis"
      data-testid="conflict-analysis-section"
    >
      <h3 id="conflict-analysis-heading">
        {t("relationshipGovernance.conflictAnalysis.heading")}
      </h3>
      <p className="sh-settings-local-note">
        {t("relationshipGovernance.conflictAnalysis.description")}
      </p>
      <ul>
        {cases.map((conflict) => (
          <li key={conflict.conflict_id}>
            <strong>{conflict.conflict_id}</strong>
            <span>
              {t(conflictClassificationLabelKey(conflict.classification) as never)}
            </span>
            <span>
              {t("relationshipGovernance.conflictAnalysis.baselineLabel")}
            </span>
            {(conflict.members ?? []).map((member) =>
              member.path ? <code key={member.path}>{member.path}</code> : null,
            )}
            {aiAvailable ? (
              <Button
                disabled={running}
                onClick={() =>
                  onAnalyze({
                    type: "case",
                    value: { conflict_id: conflict.conflict_id },
                  })
                }
                size="sm"
                variant="ghost"
              >
                {t("relationshipGovernance.conflictAnalysis.runCase")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {aiAvailable ? (
        <div className="sh-button-row">
          {classifications.map((classification) => (
            <Button
              disabled={running}
              key={classification}
              onClick={() =>
                onAnalyze({ type: "category", value: { classification } })
              }
              size="sm"
              variant="ghost"
            >
              {t("relationshipGovernance.conflictAnalysis.runCategory", {
                classification: t(
                  conflictClassificationLabelKey(classification) as never,
                ),
              })}
            </Button>
          ))}
          <Button
            disabled={running}
            onClick={() => onAnalyze({ type: "all" })}
            size="sm"
            variant="secondary"
          >
            {t("relationshipGovernance.conflictAnalysis.runAll")}
          </Button>
        </div>
      ) : null}
      {result ? (
        <div data-testid="conflict-analysis-result">
          <p>
            {result.source === "llm"
              ? t("relationshipGovernance.conflictAnalysis.sourceLlm")
              : t("relationshipGovernance.conflictAnalysis.sourceDeterministic")}
          </p>
          {failureReason ? (
            <>
              <p role="alert">
                {t("relationshipGovernance.conflictAnalysis.failureReason", {
                  reason: failureReason,
                })}
              </p>
              <p role="status">
                {t("relationshipGovernance.conflictAnalysis.deterministicNote")}
              </p>
            </>
          ) : null}
          {result.skipped_decided_cases > 0 ? (
            <p role="status">
              {t("relationshipGovernance.conflictAnalysis.skippedDecided", {
                count: result.skipped_decided_cases,
              })}
            </p>
          ) : null}
          {result.total_case_count > result.cases.length ? (
            <p role="status">
              {t("relationshipGovernance.conflictAnalysis.partialCoverage", {
                analyzed: result.cases.length,
                total: result.total_case_count,
              })}
            </p>
          ) : null}
          {result.cases.length === 0 && !failureReason ? (
            <p>{t("relationshipGovernance.conflictAnalysis.empty")}</p>
          ) : null}
          <ul>
            {result.cases.map((conclusion) => (
              <li key={conclusion.conflict_id}>
                <span>
                  {t("relationshipGovernance.conflictAnalysis.baselineLabel")}{" "}
                  {t(conflictClassificationLabelKey(conclusion.baseline_classification) as never)}
                </span>
                <p>{conclusion.summary}</p>
                <p>
                  {t("relationshipGovernance.conflictAnalysis.recommendedAction", {
                    action: t(
                      recommendedActionKeys[conclusion.recommended_action] as never,
                    ),
                  })}
                </p>
                {conclusion.recommended_keep_member ? (
                  <p>
                    {t("relationshipGovernance.conflictAnalysis.recommendedKeep", {
                      member: conclusion.recommended_keep_member,
                    })}
                  </p>
                ) : null}
                {conclusion.key_evidence.length ? (
                  <>
                    <h4>{t("relationshipGovernance.conflictAnalysis.keyEvidence")}</h4>
                    <ul>
                      {conclusion.key_evidence.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {conclusion.uncertainties.length ? (
                  <>
                    <h4>{t("relationshipGovernance.conflictAnalysis.uncertainties")}</h4>
                    <ul>
                      {conclusion.uncertainties.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <p>
                  {t("relationshipGovernance.conflictAnalysis.confidence", {
                    value: conclusion.confidence,
                  })}
                </p>
              </li>
            ))}
          </ul>
          <p className="sh-settings-local-note">
            {t("relationshipGovernance.conflictAnalysis.advisoryNote")}
          </p>
        </div>
      ) : null}
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
  conflictAnalysis,
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
      {conflictAnalysis && conflictAnalysis.cases.length > 0 ? (
        <ConflictAnalysisSection
          aiAvailable={aiAvailable}
          conflictAnalysis={conflictAnalysis}
        />
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
