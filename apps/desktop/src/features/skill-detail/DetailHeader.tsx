import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  onDelete?: () => void;
  summary: SkillDetailSummary;
}

/** 身份区实体头部：别名与名称的唯一展示位；用途说明出现在概览块与身份区
 * 字段清单（DEV-16），删除是本页唯一的全局操作。别名缺失时不再回退到
 * 裸 SkillId（技术标识不进界面）。 */
export function DetailHeader({ onDelete, summary }: DetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="sh-skill-detail__header">
      <div className="sh-skill-detail__title-row">
        <div>
          {summary.alias ? <p className="sh-skill-detail__alias">{summary.alias}</p> : null}
          <h1>{summary.name}</h1>
        </div>
        {onDelete ? (
          <Button onClick={onDelete} size="sm" variant="danger">
            {t("skillDetail.actions.delete")}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
