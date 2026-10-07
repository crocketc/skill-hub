import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { RemovalChoice, RemovalDeployment, RemovalImpact } from "./api";
import { Icon } from "../../ui/Icon";
import { RemovalShell } from "./RemovalShell";
import { RemovalDeploymentTarget, RemovalImpactDisclaimer, RemovalImpactMatrix } from "./RemovalImpactPieces";
import { displayPath } from "../../platform/displayPath";

interface RemovalImpactDialogProps {
  error?: string;
  impact: RemovalImpact;
  onCancel?: () => void;
  onConfirm: (
    choices: Record<string, RemovalChoice>,
    confirmedSharedTargets: ReadonlySet<string>,
  ) => void | Promise<void>;
  submitting?: boolean;
}

/** 链接部署形态：链接文件随主体删除一并移除，不提供保留选项。 */
const LINK_MODES: ReadonlySet<NonNullable<RemovalDeployment["mode"]>> = new Set([
  "symbolic_link",
  "directory_junction",
]);

function isLinkDeployment(deployment: RemovalDeployment): boolean {
  return deployment.mode !== undefined && LINK_MODES.has(deployment.mode);
}

/** #12-7 预勾默认：链接部署固定随删除移除；复制部署默认保留为独立拷贝。 */
function defaultChoices(impact: RemovalImpact): Record<string, RemovalChoice> {
  const choices: Record<string, RemovalChoice> = {};
  for (const deployment of impact.deployments) {
    choices[deployment.id] = isLinkDeployment(deployment) ? "remove_deployment" : "convert_to_copy";
  }
  return choices;
}

export function RemovalImpactDialog({ error, impact, onCancel, onConfirm, submitting = false }: RemovalImpactDialogProps) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, RemovalChoice>>(() => defaultChoices(impact));
  const [confirmedSharedTargets, setConfirmedSharedTargets] = useState<ReadonlySet<string>>(() => new Set());
  // 重新 prepare（impact 身份变化）时整体回到预勾默认与未确认状态：
  // 上一次影响里的逐项确认不能延续到新的影响事实上。
  const prevImpactRef = useRef(impact);
  if (prevImpactRef.current !== impact) {
    prevImpactRef.current = impact;
    setChoices(defaultChoices(impact));
    setConfirmedSharedTargets(new Set());
  }

  const deployments = impact.deployments;
  const links = deployments.filter(isLinkDeployment);
  const copies = deployments.filter((deployment) => !isLinkDeployment(deployment));
  // 共享物理目标 = 本批部署中同一 targetId 出现多次（与后端
  // ensure_shared_confirmations 的分组口径一致）。
  const targetCounts = new Map<string, number>();
  for (const deployment of deployments) {
    if (!deployment.targetId) continue;
    targetCounts.set(deployment.targetId, (targetCounts.get(deployment.targetId) ?? 0) + 1);
  }
  const isSharedTarget = (deployment: RemovalDeployment): boolean =>
    deployment.targetId !== undefined && (targetCounts.get(deployment.targetId) ?? 0) > 1;
  const requiredConfirmations = deployments.filter(
    (deployment) => isSharedTarget(deployment) && choices[deployment.id] === "remove_deployment",
  );
  const complete = requiredConfirmations.every((deployment) => confirmedSharedTargets.has(deployment.id));
  const groupNeedsConfirmation = (group: RemovalDeployment[]): boolean =>
    requiredConfirmations.some((required) => group.includes(required));
  const importRelationCount = impact.importRelationCount ?? 0;

  const toggleSharedConfirmation = (deploymentId: string, confirmed: boolean) => {
    setConfirmedSharedTargets((current) => {
      const next = new Set(current);
      if (confirmed) next.add(deploymentId);
      else next.delete(deploymentId);
      return next;
    });
  };

  const sharedConfirmationControl = (deployment: RemovalDeployment) =>
    isSharedTarget(deployment) && choices[deployment.id] === "remove_deployment" ? (
      <label className="sh-removal-impact__shared-confirm">
        <input
          checked={confirmedSharedTargets.has(deployment.id)}
          onChange={(event) => toggleSharedConfirmation(deployment.id, event.target.checked)}
          type="checkbox"
        />
        <span>{t("removal.groups.sharedConfirm")}</span>
      </label>
    ) : null;

  return (
    <RemovalShell
      eyebrow={t("removal.eyebrow")}
      footer={
        <>
          {onCancel ? (
            <div className="sh-removal-flow__actions-group">
              <Button disabled={submitting} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
            </div>
          ) : null}
          <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
            <Button
              disabled={!complete || submitting}
              onClick={() => void onConfirm(choices, confirmedSharedTargets)}
              size="lg"
              variant="danger"
            >
              {submitting ? t("removal.submitting") : t("removal.confirm")}
            </Button>
          </div>
        </>
      }
      status={submitting ? { kind: "info", text: t("removal.submitting") } : null}
      title={t("removal.heading", { name: impact.skillName })}
    >
      <p>{t("removal.description")}</p>
      {/* #12-7 摘要优先：先给结论（删什么、默认保留什么、连带影响），
          分组明细默认收起，展开后可逐项调整。 */}
      <section aria-label={t("removal.summary.title")} className="sh-removal-impact__summary">
        <h3 className="sh-removal-impact__summary-title">{t("removal.summary.title")}</h3>
        <ul className="sh-removal-impact__summary-lines">
          <li>{t("removal.summary.central")}</li>
          {links.length > 0 ? <li>{t("removal.summary.links", { count: links.length })}</li> : null}
          {copies.length > 0 ? <li>{t("removal.summary.copies", { count: copies.length })}</li> : null}
          {importRelationCount > 0 ? <li>{t("removal.summary.imports", { count: importRelationCount })}</li> : null}
        </ul>
      </section>
      {links.length > 0 ? (
        <details className="sh-removal-impact__group">
          <summary>
            <span className="sh-removal-impact__group-label">{t("removal.groups.links")}</span>
            <span className="sh-removal-impact__group-outcome">{t("removal.groups.linksOutcome")}</span>
            {groupNeedsConfirmation(links) ? (
              <span className="sh-removal-impact__group-badge">
                <Icon aria-hidden="true" name="warning" size={14} />
                {t("removal.groups.needsConfirmation")}
              </span>
            ) : null}
          </summary>
          <ul className="sh-workflow-list">
            {links.map((deployment) => (
              <li className="sh-workflow-list__item" key={deployment.id}>
                <RemovalDeploymentTarget deployment={deployment} />
                <p className="sh-removal-impact__fixed-outcome">{t("removal.groups.linkWillBeDeleted")}</p>
                {sharedConfirmationControl(deployment)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {copies.length > 0 ? (
        <details className="sh-removal-impact__group">
          <summary>
            <span className="sh-removal-impact__group-label">{t("removal.groups.copies")}</span>
            <span className="sh-removal-impact__group-outcome">{t("removal.groups.copiesOutcome")}</span>
            {groupNeedsConfirmation(copies) ? (
              <span className="sh-removal-impact__group-badge">
                <Icon aria-hidden="true" name="warning" size={14} />
                {t("removal.groups.needsConfirmation")}
              </span>
            ) : null}
          </summary>
          <ul className="sh-workflow-list">
            {copies.map((deployment) => (
              <li className="sh-workflow-list__item" key={deployment.id}>
                <RemovalDeploymentTarget deployment={deployment} />
                <fieldset
                  aria-label={`${t("removal.choiceLabel")}：${displayPath(deployment.path)}`}
                  className="sh-removal-impact__choice"
                >
                  <label className="sh-removal-impact__choice-option">
                    <input
                      checked={choices[deployment.id] === "convert_to_copy"}
                      name={`removal-choice-${deployment.id}`}
                      onChange={() => setChoices((current) => ({ ...current, [deployment.id]: "convert_to_copy" }))}
                      type="radio"
                      value="convert_to_copy"
                    />
                    <span className="sh-removal-impact__choice-text">
                      <span>{t("removal.groups.copyKeep")}</span>
                      <small>{t("removal.groups.copyKeepHint")}</small>
                    </span>
                  </label>
                  <label className="sh-removal-impact__choice-option">
                    <input
                      checked={choices[deployment.id] === "remove_deployment"}
                      name={`removal-choice-${deployment.id}`}
                      onChange={() => setChoices((current) => ({ ...current, [deployment.id]: "remove_deployment" }))}
                      type="radio"
                      value="remove_deployment"
                    />
                    <span className="sh-removal-impact__choice-text">
                      <span>{t("removal.groups.copyDelete")}</span>
                      <small>{t("removal.groups.copyDeleteHint")}</small>
                    </span>
                  </label>
                </fieldset>
                {sharedConfirmationControl(deployment)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {/* DEV-97：影响矩阵与批量删除共用同一结构化呈现。 */}
      <RemovalImpactMatrix impact={impact} />
      {/* P1-15：提交前固定说明保留什么与恢复方式（如实提示仅备份可恢复）；
          W1-2：草稿说明由共享组件在确有草稿时追加。 */}
      <RemovalImpactDisclaimer impacts={[impact]} />
      {error ? <p className="sh-removal-flow__error" role="alert"><Icon aria-hidden="true" name="failure" size={16} />{error}</p> : null}
    </RemovalShell>
  );
}
