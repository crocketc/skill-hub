import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  onDelete?: () => void;
  summary: SkillDetailSummary;
}

/** 身份区实体头部：别名与名称的唯一展示位；用途说明只出现在概览块（P1-12），
 * 删除是本页唯一的全局操作。 */
export function DetailHeader({ onDelete, summary }: DetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="sh-skill-detail__header">
      <div className="sh-skill-detail__title-row">
        <div>
          <p className="sh-skill-detail__alias">{summary.alias ?? summary.id}</p>
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
