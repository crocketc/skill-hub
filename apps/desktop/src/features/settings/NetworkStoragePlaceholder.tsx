import { useTranslation } from "react-i18next";

export function NetworkStoragePlaceholder() {
  const { t } = useTranslation();
  return <section aria-labelledby="settings-network-storage-heading" className="sh-settings-card sh-settings-placeholder"><p className="sh-eyebrow">{t("settings.networkStorage.eyebrow")}</p><h2 id="settings-network-storage-heading">{t("settings.networkStorage.heading")}</h2><p>{t("settings.networkStorage.description")}</p><span className="sh-status sh-status--muted">{t("settings.networkStorage.planned")}</span></section>;
}
