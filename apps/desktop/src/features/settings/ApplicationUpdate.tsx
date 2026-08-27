import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { AppUpdate, BuildTrust, SettingsFacade } from "./api";
import { unavailableSettingsFacade } from "./api";

export function ApplicationUpdate({ buildTrust, facade = unavailableSettingsFacade, update }: { buildTrust: BuildTrust; facade?: SettingsFacade; update: AppUpdate | null }) {
  const { t } = useTranslation();
  if (!update) return <section className="sh-settings-card"><h2>{t("settings.update.heading")}</h2><p>{t("settings.update.current")}</p></section>;
  const unsigned = buildTrust === "windows_unsigned" || buildTrust === "unknown";
  return <section aria-labelledby="settings-update-heading" className="sh-settings-card"><h2 id="settings-update-heading">{t("settings.update.heading")}</h2><p>{t("settings.update.available", { version: update.version })}</p><p>{unsigned ? t("settings.update.unsigned") : t("settings.update.signed")}</p><Button onClick={() => void facade.execute({ type: "open_official_release" })} variant="secondary">{t("settings.update.openRelease")}</Button></section>;
}
