import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

export interface DiscoveryEntryProps {
  onStartImport: () => void;
}

export function LocalDiscovery({ onStartImport }: DiscoveryEntryProps) {
  const { t } = useTranslation();
  return (
    <article className="sh-discovery-card">
      <div className="sh-discovery-card__heading">
        <div>
          <p className="sh-discovery-card__eyebrow">{t("discovery.local.eyebrow")}</p>
          <h2>{t("discovery.local.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-card__icon">⌂</span>
      </div>
      <p>{t("discovery.local.description")}</p>
      <ul>
        <li>{t("discovery.local.factPath")}</li>
        <li>{t("discovery.local.factReadOnly")}</li>
      </ul>
      <Button onClick={onStartImport}>{t("discovery.importSkill")}</Button>
    </article>
  );
}
