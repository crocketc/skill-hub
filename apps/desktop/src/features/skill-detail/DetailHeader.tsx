import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { AdjacentSkillContext, SkillDetailSummary } from "./api";

interface DetailHeaderProps {
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  summary: SkillDetailSummary;
}

export function DetailHeader({ adjacent, backSearch, summary }: DetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="sh-skill-detail__header">
      <Link className="sh-skill-detail__back" to={{ pathname: "/library", search: backSearch }}>
        {t("skillDetail.navigation.back")}
      </Link>
      <div className="sh-skill-detail__title-row">
        <div>
          <p>{summary.alias ?? summary.id}</p>
          <h1>{summary.name}</h1>
          <p>{summary.purpose}</p>
        </div>
        {adjacent ? (
          <div className="sh-skill-detail__adjacent">
            <span>{t("skillDetail.navigation.position", { position: adjacent.position, total: adjacent.total })}</span>
            {adjacent.previous ? (
              <Link
                className="sh-button sh-button--ghost sh-button--sm"
                to={{ pathname: `/library/${adjacent.previous.id}`, search: backSearch }}
              >
                {t("skillDetail.navigation.previous")}
              </Link>
            ) : null}
            {adjacent.next ? (
              <Link
                className="sh-button sh-button--ghost sh-button--sm"
                to={{ pathname: `/library/${adjacent.next.id}`, search: backSearch }}
              >
                {t("skillDetail.navigation.next")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
