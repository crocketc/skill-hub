import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { SkillLibraryReturnState } from "./detailContext";
import type { AdjacentSkillContext, SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  backPathname: string;
  detailPathname: string;
  libraryReturn?: SkillLibraryReturnState;
  summary: SkillDetailSummary;
}

export function DetailHeader({
  adjacent,
  backPathname,
  backSearch,
  detailPathname,
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
      {adjacent ? (
        <nav aria-label={t("skillDetail.navigation.label")} className="sh-skill-detail__adjacent">
          <span>{t("skillDetail.navigation.position", { position: adjacent.position, total: adjacent.total })}</span>
          <div className="sh-skill-detail__adjacent-controls">
            {adjacent.previous ? (
              <Link
                className="sh-button sh-button--ghost sh-button--sm"
                to={{ pathname: `${detailPathname}/${adjacent.previous.id}`, search: backSearch }}
              >
                {t("skillDetail.navigation.previous")}
              </Link>
            ) : (
              <button className="sh-button sh-button--ghost sh-button--sm" disabled type="button">
                {t("skillDetail.navigation.previous")}
              </button>
            )}
            {adjacent.next ? (
              <Link
                className="sh-button sh-button--ghost sh-button--sm"
                to={{ pathname: `${detailPathname}/${adjacent.next.id}`, search: backSearch }}
              >
                {t("skillDetail.navigation.next")}
              </Link>
            ) : (
              <button className="sh-button sh-button--ghost sh-button--sm" disabled type="button">
                {t("skillDetail.navigation.next")}
              </button>
            )}
          </div>
        </nav>
      ) : null}
    </header>
  );
}
