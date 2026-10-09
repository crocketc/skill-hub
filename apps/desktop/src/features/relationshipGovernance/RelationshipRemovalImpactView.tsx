import { useEffect, useRef, useState } from "react";
import { displayPath } from "../../platform/displayPath";
import { useTranslation } from "react-i18next";
import type { PreparedUsageChange, RemovalImpactFact, UsageRelationTarget } from "../../api/bindings";
import { Button } from "../../ui/Button";
import { AgentPresentation } from "../../ui/AgentPresentation";
import {
  minimalImpactActionLabelKey,
  recognitionLabelKey,
  relationshipLabelKey,
} from "./relationshipGovernance";

export interface RelationshipRemovalImpactViewProps {
  /** 只读加载既有 RemovalImpact 事实；本组件不执行任何变更。 */
  loadImpact?: () => Promise<RemovalImpactFact>;
  triggerLabel?: string;
  /** 统一释放流程传入与最终提交同源的 T04 准备快照。 */
  usageChange?: PreparedUsageChange;
  /** 挂载即展开（治理预览等已处于确认上下文时）；缺省保持原折叠行为。 */
  defaultOpen?: boolean;
}

function usageTargetLabel(target: UsageRelationTarget, t: (key: string) => string) {
  return t(`undeploy.flow.groups.${target.kind === "shared_directory" ? "shared" : target.kind}`);
}

function usageActionLabel(action: PreparedUsageChange["impacts"][number]["action"], t: (key: string) => string) {
  return t(`undeploy.flow.actions.${action}`);
}

/**
 * Task 7：共享的移除影响预览。先呈现确定性影响事实（最小影响动作、
 * 共享消费者、其他路径、回退/备份、权限受限），文件变更永远发生在
 * 用户确认之后，由既有移除/迁移命令负责。
 */
export function RelationshipRemovalImpactView({
  defaultOpen = false,
  loadImpact,
  triggerLabel,
  usageChange,
}: RelationshipRemovalImpactViewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [impact, setImpact] = useState<RemovalImpactFact>();
  const [failed, setFailed] = useState(false);
  const loadingRef = useRef(false);

  // 展开且尚无事实时加载一次；默认展开（治理预览）也走同一条只读加载路径。
  useEffect(() => {
    if (!open || impact || failed || loadingRef.current || !loadImpact || usageChange) return;
    loadingRef.current = true;
    loadImpact().then((value) => {
      setImpact(value);
    }).catch(() => {
      setFailed(true);
    }).finally(() => {
      loadingRef.current = false;
    });
  }, [failed, impact, loadImpact, open]);

  const toggle = () => setOpen((value) => !value);

  return (
    <div className="sh-removal-impact" data-testid="removal-impact">
      {usageChange ? (
        <div data-testid="removal-impact-facts">
          <h4>{t("undeploy.flow.previewHeading")}</h4>
          <ul className="sh-usage-release-impact__items">
            {usageChange.impacts.map((item, index) => (
              <li key={`${item.relation_ids.join(":")}-${index}`}>
                <strong>{usageTargetLabel(item.target, (key) => String(t(key as never)))}</strong>
                <span> · {usageActionLabel(item.action, (key) => String(t(key as never)))}</span>
                <p>{usageChange.action === "manage"
                  ? item.description
                  : t(`undeploy.flow.actionNotes.${item.action}` as never)}</p>
              </li>
            ))}
          </ul>
          {usageChange.subject_versions.length > 0 ? (
            <>
              <h4>{t("relationships.governance.manage.subjectVersions")}</h4>
              <ul className="sh-usage-release-impact__items" data-testid="usage-manage-subject-versions">
                <li>{t("relationships.governance.manage.originalVersionNote", { count: usageChange.subject_versions.length })}</li>
              </ul>
            </>
          ) : null}
          {usageChange.entry_evidence.length > 0 ? (
            <>
              <h4>{t("undeploy.flow.entriesHeading")}</h4>
              <ul className="sh-usage-release-impact__items">
                {usageChange.entry_evidence.map((entry, index) => (
                  <li key={`${entry.entry_key.directory_id}-${entry.entry_key.relative_entry_path}-${index}`}>
                    {t("undeploy.flow.entry", { path: displayPath(entry.path) })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h4>{t("undeploy.flow.consumerHeading")}</h4>
          {usageChange.consumers.length > 0 ? (
            <ul className="sh-usage-release-impact__items">
              {usageChange.consumers.map((consumer, index) => (
                <li key={`${consumer.relation_ids.join(":")}-${index}`}>
                  <div className="sh-usage-release-impact__consumer">
                    <strong>{usageTargetLabel(consumer.target, (key) => String(t(key as never)))}</strong>
                    {consumer.target.agent_client_id ? <AgentPresentation agentId={consumer.target.agent_client_id} /> : null}
                    <span>{t(`undeploy.flow.consumerManagement.${consumer.management}` as never)}</span>
                    <span>{t(`undeploy.flow.consumerHealth.${consumer.health_reasons.length === 1 && consumer.health_reasons[0] === "normal" ? "normal" : "attention"}` as never)}</span>
                  </div>
                  {consumer.path ? <span>{displayPath(consumer.path)}</span> : null}
                  {consumer.management === "unmanaged" ? <p>{t("undeploy.flow.unmanagedWarning")}</p> : null}
                </li>
              ))}
            </ul>
          ) : <p>{t("undeploy.flow.noOtherConsumers")}</p>}
          {usageChange.limitations.length > 0 ? (
            <p role="note">{t("undeploy.flow.recordOnlyNote")}</p>
          ) : null}
        </div>
      ) : (
        <>
          <Button aria-expanded={open} onClick={toggle} size="sm" variant="secondary">
            {open ? t("relationshipGovernance.removalImpact.hide") : triggerLabel ?? t("relationshipGovernance.matrix.viewRemovalImpact")}
          </Button>
          {failed ? <p role="alert">{t("relationshipGovernance.removalImpact.loadError")}</p> : null}
        </>
      )}
      {!usageChange && open && impact ? (
        <div data-testid="removal-impact-facts">
          <h4>{t("relationshipGovernance.removalImpact.heading")}</h4>
          <p>{t("relationshipGovernance.removalImpact.description")}</p>
          <p>
            <strong>{t("relationshipGovernance.removalImpact.minimalAction")}</strong>{" "}
            {t(minimalImpactActionLabelKey(impact.minimal_action) as never)}
          </p>
          {impact.current_agent_reads_shared_directory ? (
            <p>{t("relationshipGovernance.removalImpact.currentAgentReadsShared")}</p>
          ) : null}
          <p>
            {impact.other_consumers.length > 0
              ? <>
                  {t("relationshipGovernance.removalImpact.otherConsumers", { agents: "" })}
                  {impact.other_consumers.map((consumer, index) => (
                    <span key={`${consumer.agent_client_id}-${consumer.relation_id ?? index}`}>
                      {index > 0 ? `${t("importWorkflow.governance.impact.agentSeparator") as never} ` : ""}
                      <AgentPresentation agentId={consumer.agent_client_id} />{" "}
                      ({t(recognitionLabelKey(consumer.recognition) as never)})
                    </span>
                  ))}
                </>
              : t("relationshipGovernance.removalImpact.noOtherConsumers")}
          </p>
          <p>
            {impact.other_skill_paths.length > 0
              ? t("relationshipGovernance.removalImpact.otherSkillPaths", {
                  paths: impact.other_skill_paths
                    .map((path) => `${displayPath(path.path)} (${t(relationshipLabelKey(path.relationship) as never)})`)
                    .join(t("importWorkflow.governance.impact.agentSeparator") as never),
                })
              : t("relationshipGovernance.removalImpact.noOtherSkillPaths")}
          </p>
          <p>
            {impact.backup.rollback_available
              ? t("relationshipGovernance.removalImpact.rollbackAvailable", {
                  path: impact.backup.backup_location ?? "—",
                })
              : t("relationshipGovernance.removalImpact.rollbackUnavailable")}
          </p>
          {impact.permission_limited ? (
            <p role="alert">{t("relationshipGovernance.removalImpact.permissionLimited")}</p>
          ) : null}
          {impact.governance_tasks.length > 0 ? (
            <p>
              {t("relationshipGovernance.removalImpact.governanceTasks", {
                count: impact.governance_tasks.length,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
