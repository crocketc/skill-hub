import { useTranslation } from "react-i18next";
import type { SettingsSnapshot } from "./api";
export function BackupSettings({ settings }: { settings: SettingsSnapshot }) { const { t } = useTranslation(); return <section className="sh-settings-card"><h2>{t("settings.backup.heading")}</h2><dl className="sh-facts"><dt>{t("settings.backup.location")}</dt><dd>{settings.backup.location}</dd><dt>{t("settings.backup.retention")}</dt><dd>{settings.backup.retentionDays} {t("settings.backup.days")}</dd></dl></section>; }
