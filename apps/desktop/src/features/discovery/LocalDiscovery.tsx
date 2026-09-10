import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";

export interface DiscoveryEntryProps {
  onStartImport: () => void;
}

export function LocalDiscovery({ onStartImport }: DiscoveryEntryProps) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("discovery.local.title")} className="sh-discovery-module">
      <header className="sh-discovery-module__heading">
        <div>
          <p className="sh-discovery-module__eyebrow">{t("discovery.local.eyebrow")}</p>
          <h2>{t("discovery.local.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-module__icon">
          <Icon name="overview" size={24} />
        </span>
      </header>
      <p className="sh-discovery-module__description">{t("discovery.local.description")}</p>
      <ul className="sh-discovery-facts">
        <li>{t("discovery.local.factPath")}</li>
        <li>{t("discovery.local.factReadOnly")}</li>
      </ul>
      <div>
        <Button onClick={onStartImport}>{t("discovery.importSkill")}</Button>
      </div>
    </section>
  );
}
