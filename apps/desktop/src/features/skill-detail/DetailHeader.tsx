import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { SkillLibraryReturnState } from "./detailContext";
import type { SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  backSearch: string;
  backPathname: string;
  libraryReturn?: SkillLibraryReturnState;
  summary: SkillDetailSummary;
}

export function DetailHeader({
  backPathname,
  backSearch,
  libraryReturn,
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
      </div>
    </header>
  );
}
