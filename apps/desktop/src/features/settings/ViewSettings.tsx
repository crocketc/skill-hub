import { useTranslation } from "react-i18next";
import type { SettingsSnapshot } from "./api";
export function ViewSettings({ settings }: { settings: SettingsSnapshot }) { const { t } = useTranslation(); return <section className="sh-settings-card"><h2>{t("settings.view.heading")}</h2><p>{t("settings.view.density", { density: settings.view.density })}</p></section>; }
