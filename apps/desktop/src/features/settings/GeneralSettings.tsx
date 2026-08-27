import { useTranslation } from "react-i18next";
import type { SettingsSnapshot } from "./api";
export function GeneralSettings({ settings }: { settings: SettingsSnapshot }) { const { t } = useTranslation(); return <section className="sh-settings-card"><h2>{t("settings.general.heading")}</h2><dl className="sh-facts"><dt>{t("settings.general.language")}</dt><dd>{settings.appearance.language}</dd><dt>{t("settings.general.theme")}</dt><dd>{settings.appearance.theme}</dd></dl></section>; }
