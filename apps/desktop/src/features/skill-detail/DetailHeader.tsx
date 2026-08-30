import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "../../ui/Button";
import type { SkillLibraryReturnState } from "./detailContext";
import type { SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  backSearch: string;
  backPathname: string;
  libraryReturn?: SkillLibraryReturnState;
  onDelete?: () => void;
  summary: SkillDetailSummary;
}

export function DetailHeader({
  backPathname,
  backSearch,
  libraryReturn,
  onDelete,
  summary,
}: DetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="sh-skill-detail__header">
      <Link
        className="sh-skill-detail__back"
        state={libraryReturn ? { libraryReturn } : undefined}
        to={{ pathname: backPathname, search: backSearch }}
      >
        {t("skillDetail.navigation.back")}
      </Link>
      <div className="sh-skill-detail__title-row">
        <div>
          <p>{summary.alias ?? summary.id}</p>
          <h1>{summary.name}</h1>
          <p>{summary.purpose}</p>
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
