import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  onDispatch?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  /** W3-1：安全预警时的「安全处理」入口（去安全页处理）；无预警或动作缺失时不渲染。 */
  onSecurityHandling?: () => void;
  summary: SkillDetailSummary;
}

/** 身份区头部保留唯一名称展示位和冻结的统一主操作槽。 */
export function DetailHeader({ onDelete, onDispatch, onExport, onSecurityHandling, summary }: DetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="sh-skill-detail__header">
      <div className="sh-skill-detail__title-row">
        <div>
          {summary.alias ? <p className="sh-skill-detail__alias">{summary.alias}</p> : null}
          <h1>{summary.name}</h1>
        </div>
        {onDispatch || onExport || onDelete || onSecurityHandling ? (
          <div aria-label={t("skillDetail.actions.label")} className="sh-skill-detail__header-actions" role="group">
            {/* W3-1：预警 Skill 的唯一「安全处理」入口；动作缺失时不渲染死按钮。 */}
            {onSecurityHandling && summary.securityAlert ? (
              <Button onClick={onSecurityHandling} size="sm" variant="secondary">
                {t("skillDetail.actions.securityHandling")}
              </Button>
            ) : null}
            {onDispatch ? (
              <Button
                aria-label={t("skillLibrary.drawer.actions.dispatchSkill", { name: summary.name })}
                onClick={onDispatch}
                size="sm"
                variant="primary"
              >
                {t("skillLibrary.drawer.actions.dispatch")}
              </Button>
            ) : null}
            {onExport ? (
              <Button
                aria-label={t("skillLibrary.drawer.actions.exportSkill", { name: summary.name })}
                onClick={onExport}
                size="sm"
                variant="secondary"
              >
                {t("skillLibrary.drawer.actions.export")}
              </Button>
            ) : null}
            {onDelete ? (
              <Button onClick={onDelete} size="sm" variant="danger">
                {t("skillDetail.actions.delete")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
