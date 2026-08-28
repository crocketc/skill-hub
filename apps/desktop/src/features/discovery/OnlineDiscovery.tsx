import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

export interface OnlineDiscoveryProps {
  onStartImport: () => void;
}

export function OnlineDiscovery({ onStartImport }: OnlineDiscoveryProps) {
  const { t } = useTranslation();
  return (
    <article className="sh-discovery-card">
      <div className="sh-discovery-card__heading">
        <div>
          <p className="sh-discovery-card__eyebrow">{t("discovery.online.eyebrow")}</p>
          <h2>{t("discovery.online.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-card__icon">↗</span>
      </div>
      <p>{t("discovery.online.description")}</p>
      <ul>
        <li>{t("discovery.online.factNoNetwork")}</li>
        <li>{t("discovery.online.factPreview")}</li>
      </ul>
      <Button onClick={onStartImport} variant="secondary">{t("discovery.importSkill")}</Button>
    </article>
  );
}
