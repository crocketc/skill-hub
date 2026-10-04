import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  onDispatch?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  summary: SkillDetailSummary;
}

/** 身份区头部保留唯一名称展示位和冻结的统一主操作槽。 */
export function DetailHeader({ onDelete, onDispatch, onExport, summary }: DetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="sh-skill-detail__header">
      <div className="sh-skill-detail__title-row">
        <div>
          {summary.alias ? <p className="sh-skill-detail__alias">{summary.alias}</p> : null}
          <h1>{summary.name}</h1>
        </div>
        {onDispatch || onExport || onDelete ? (
          <div aria-label={t("skillDetail.actions.label")} className="sh-skill-detail__header-actions" role="group">
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
