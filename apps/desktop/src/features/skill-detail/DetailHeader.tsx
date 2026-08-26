import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "../../ui/Button";
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
              <Button size="sm" variant="ghost">
                {t("skillDetail.navigation.previous")}
              </Button>
            ) : null}
            {adjacent.next ? (
              <Button size="sm" variant="ghost">
                {t("skillDetail.navigation.next")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
