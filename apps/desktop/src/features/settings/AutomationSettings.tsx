import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsFacade, SettingsSnapshot } from "./api";

export function AutomationSettings({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { t } = useTranslation();
  const [automation, setAutomation] = useState(settings.automation);
  const [error, setError] = useState(false);
  const toggle = (key: keyof SettingsSnapshot["automation"]) => {
    const previous = automation;
    const next = { ...automation, [key]: !automation[key] };
    setAutomation(next);
    setError(false);
    void facade.execute({ type: "set_automation", payload: { automation: next } }).catch(() => {
      setAutomation(previous);
      setError(true);
    });
  };
  return <section className="sh-settings-card"><h2>{t("settings.automation.heading")}</h2>{(["perSkill", "batch", "global"] as const).map((key) => <label className="sh-settings-toggle" key={key}><input aria-label={t(`settings.automation.${key}`)} checked={automation[key]} onChange={() => toggle(key)} type="checkbox" />{t(`settings.automation.${key}`)}</label>)}{error ? <p role="alert">{t("settings.automation.saveFailed")}</p> : null}</section>;
}
