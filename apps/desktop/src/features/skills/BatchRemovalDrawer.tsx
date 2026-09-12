import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { Drawer } from "../../ui/Drawer";
import { Icon } from "../../ui/Icon";
import type { RemovalChoice, RemovalImpact } from "../removal/api";
import "./batchRemovalDrawer.css";

/**
 * M-21 #4：批量删除确认从“页面流末尾的嵌入对话框”改为自下而上滑出的
 * 底部抽屉——用户不再被要求跳到页面底部、原列表也不滚动/跳转。
 * 确认内容与既有删除影响预览保持同一语义：逐 Skill 列出部署关系与
 * 影响维度，保留/恢复说明常驻，二次点击确认（QA-001）后才提交。
 */
export interface BatchRemovalDrawerProps {
  error?: string;
  impacts: RemovalImpact[];
  onCancel: () => void;
  onConfirm: (choices: Record<string, Record<string, RemovalChoice>>) => void | Promise<void>;
  submitting?: boolean;
}

export function BatchRemovalDrawer({
  error,
  impacts,
  onCancel,
  onConfirm,
  submitting = false,
}: BatchRemovalDrawerProps): JSX.Element {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, Record<string, RemovalChoice>>>({});
  // 抽屉挂载（确认流程打开）时记录触发元素，关闭后焦点回到原位
  // （与 RemovalShell 的返回焦点语义一致）。
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  // QA-001：二次点击确认取代 FORCE DELETE 文本输入——第一次点击
  // 只改变按钮文案要求再次确认，第二次点击才真正提交。
  const [armed, setArmed] = useState(false);
  const count = impacts.length;
  const complete = impacts.every((impact) =>
    impact.deployments.every(
      (deployment) => choices[impact.operationId ?? ""]?.[deployment.id],
    ),
  );
  const confirmChoices = () => {
    void onConfirm(Object.fromEntries(
      impacts.map((impact) => [impact.operationId ?? "", choices[impact.operationId ?? ""] ?? {}]),
    ));
  };

  return (
    <Drawer
      description={t("removal.batch.description", { count })}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
      panelClassName="sh-skill-library__removal-drawer"
      returnFocusRef={returnFocusRef}
      title={t("removal.batch.heading")}
    >
      <div className="sh-skill-library__removal">
        <p className="sh-skill-library__removal-eyebrow">{t("removal.batch.eyebrow")}</p>
        <p>{t("removal.batch.description", { count })}</p>
        {/* P1-15：批量删除同属“删除库中 Skill”对象——提交前固定说明
           保留什么（库外原文件）与恢复方式（仅事先导出的备份）。 */}
        <div className="sh-skill-library__removal-disclaimer">
          <p>{t("removal.retained")}</p>
          <p>{t("removal.recovery")}</p>
        </div>
        {impacts.map((impact) => (
          <section className="sh-skill-library__removal-skill" key={impact.operationId ?? impact.skillId}>
            <h3>{impact.skillName}</h3>
            {impact.dependentProjects.length > 0 ? (
              <p className="sh-notice">{t("removal.dependents", { projects: impact.dependentProjects.join(", ") })}</p>
            ) : null}
            {impact.deployments.length === 0 ? <p>{t("removal.batch.noDeployments")}</p> : null}
            {impact.deployments.map((deployment) => (
              <label className="sh-skill-library__removal-deployment" key={deployment.id}>
                <span>
                  <strong>{deployment.label}</strong>
                  <small>{deployment.path}</small>
                </span>
                <select
                  aria-label={`${t("removal.choiceLabel")}: ${deployment.label}`}
                  onChange={(event) => setChoices((current) => ({
                    ...current,
                    [impact.operationId ?? ""]: {
                      ...current[impact.operationId ?? ""],
                      [deployment.id]: event.target.value as RemovalChoice,
                    },
                  }))}
                  value={choices[impact.operationId ?? ""]?.[deployment.id] ?? ""}
                >
                  <option value="">{t("removal.choose")}</option>
                  <option value="keep_deployed">{t("removal.choices.keep")}</option>
                  <option value="remove_deployment">{t("removal.choices.remove")}</option>
                  <option value="convert_to_copy">{t("removal.choices.convert")}</option>
                </select>
              </label>
            ))}
            {/* QA-001：完整影响矩阵逐项提示；未知外部内容只提示、不修改。 */}
            {impact.declaredDependencies.length > 0 ? (
              <p className="sh-notice">
                {`${t("removal.batch.impact.declaredDependencies")}: ${impact.declaredDependencies.join(", ")}`}
              </p>
            ) : null}
            {impact.combinations.length > 0 ? (
              <p className="sh-notice">
                {`${t("removal.batch.impact.combinations")}: ${impact.combinations.join(", ")}`}
              </p>
            ) : null}
            {impact.pinnedVersions.length > 0 ? (
              <p className="sh-notice">
                {t("removal.batch.impact.pinnedVersions", { count: impact.pinnedVersions.length })}
              </p>
            ) : null}
            {impact.relatedSkills.length > 0 ? (
              <p className="sh-notice">
                {`${t("removal.batch.impact.relatedSkills")}: ${impact.relatedSkills.join(", ")}`}
              </p>
            ) : null}
            {impact.unknownExternalReferences.length > 0 ? (
              <p className="sh-notice">
                {`${t("removal.batch.impact.unknownExternalReferences")}: ${impact.unknownExternalReferences.join(", ")}`}
              </p>
            ) : null}
          </section>
        ))}
        {error ? <p role="alert">{error}</p> : null}
        {submitting ? (
          <p className="sh-skill-library__removal-status" role="status">
            <Icon aria-hidden="true" name="info" size={16} />
            {t("removal.batch.busy", { count })}
          </p>
        ) : null}
        <footer className="sh-skill-library__removal-actions">
          <Button disabled={submitting} onClick={onCancel} variant="secondary">
            {t("actions.cancel")}
          </Button>
          {/* 非原子批量风险提示紧邻提交动作，与危险主操作同处一行。 */}
          <small className="sh-skill-library__removal-risk">{t("removal.batch.nonAtomicNotice")}</small>
          {armed ? (
            <Button disabled={submitting} onClick={confirmChoices} variant="danger">
              {t("removal.batch.armConfirm", { count })}
            </Button>
          ) : (
            <Button disabled={!complete || submitting} onClick={() => setArmed(true)} variant="danger">
              {t("removal.batch.continue")}
            </Button>
          )}
        </footer>
      </div>
    </Drawer>
  );
}
