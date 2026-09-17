import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemovalImpactFact } from "../../api/bindings";
import { Button } from "../../ui/Button";
import {
  minimalImpactActionLabelKey,
  recognitionLabelKey,
  relationshipLabelKey,
} from "./relationshipGovernance";

export interface RelationshipRemovalImpactViewProps {
  /** 只读加载既有 RemovalImpact 事实；本组件不执行任何变更。 */
  loadImpact: () => Promise<RemovalImpactFact>;
  triggerLabel: string;
  /** 挂载即展开（治理预览等已处于确认上下文时）；缺省保持原折叠行为。 */
  defaultOpen?: boolean;
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
}: RelationshipRemovalImpactViewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [impact, setImpact] = useState<RemovalImpactFact>();
  const [failed, setFailed] = useState(false);
  const loadingRef = useRef(false);

  // 展开且尚无事实时加载一次；默认展开（治理预览）也走同一条只读加载路径。
  useEffect(() => {
    if (!open || impact || failed || loadingRef.current) return;
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
      <Button aria-expanded={open} onClick={toggle} size="sm" variant="secondary">
        {open ? t("relationshipGovernance.removalImpact.hide") : triggerLabel}
      </Button>
      {failed ? <p role="alert">{t("relationshipGovernance.removalImpact.loadError")}</p> : null}
      {open && impact ? (
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
              ? t("relationshipGovernance.removalImpact.otherConsumers", {
                  agents: impact.other_consumers
                    .map((consumer) => `${consumer.agent_client_id} (${
                      t(recognitionLabelKey(consumer.recognition) as never)
                    })`)
                    .join(t("importWorkflow.governance.impact.agentSeparator") as never),
                })
              : t("relationshipGovernance.removalImpact.noOtherConsumers")}
          </p>
          <p>
            {impact.other_skill_paths.length > 0
              ? t("relationshipGovernance.removalImpact.otherSkillPaths", {
                  paths: impact.other_skill_paths
                    .map((path) => `${path.path} (${t(relationshipLabelKey(path.relationship) as never)})`)
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
