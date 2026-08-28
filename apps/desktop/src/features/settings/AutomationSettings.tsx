import { useTranslation } from "react-i18next";
import type { SettingsSnapshot } from "./api";
export function AutomationSettings({ settings }: { settings: SettingsSnapshot }) { const { t } = useTranslation(); return <section className="sh-settings-card"><h2>{t("settings.automation.heading")}</h2><ul className="sh-settings-list"><li>{t("settings.automation.perSkill")}: {String(settings.automation.perSkill)}</li><li>{t("settings.automation.batch")}: {String(settings.automation.batch)}</li><li>{t("settings.automation.global")}: {String(settings.automation.global)}</li></ul></section>; }
