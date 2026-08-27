import { useTranslation } from "react-i18next";
import type { SettingsSnapshot } from "./api";
export function LibrarySettings({ settings }: { settings: SettingsSnapshot }) { const { t } = useTranslation(); return <section className="sh-settings-card"><h2>{t("settings.library.heading")}</h2><dl className="sh-facts"><dt>{t("settings.library.path")}</dt><dd>{settings.library.path}</dd></dl>{settings.library.migrationAvailable ? <p className="sh-settings-note">{t("settings.library.migrationAvailable")}</p> : null}</section>; }
