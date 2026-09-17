import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../../ui/Switch";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
import type { SettingsFacade, SettingsSnapshot } from "./api";

export function AutomationSettings({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const [automation, setAutomation] = useState(settings.automation);
  const [error, setError] = useState(false);
  const toggle = (key: keyof SettingsSnapshot["automation"]) => {
    const previous = automation;
    const next = { ...automation, [key]: !automation[key] };
    setAutomation(next);
    setError(false);
    void runTrackedOperation({
      kind: "settings_automation",
      label: t("settings.automation.heading"),
      mode: "instant",
      notifications,
      translate: (name, options) => t(name as never, options),
      successNotice: () => ({ tone: "success", title: t("settings.automation.saved") }),
      errorNotice: (_error, message) => ({ tone: "danger", title: t("settings.automation.saveFailed"), detail: message }),
      run: () => facade.execute({ type: "set_automation", payload: { automation: next } }),
    }).catch(() => {
      setAutomation(previous);
      setError(true);
    });
  };
  return (
    <section className="sh-settings-card">
      <h2>{t("settings.automation.heading")}</h2>
      <div className="sh-settings-capabilities">
        {(["perSkill", "batch", "global"] as const).map((key) => (
          <Switch
            checked={automation[key]}
            key={key}
            label={t(`settings.automation.${key}`)}
            name={`automation-${key}`}
            onChange={() => toggle(key)}
          />
        ))}
      </div>
      {error ? <p role="alert">{t("settings.automation.saveFailed")}</p> : null}
    </section>
  );
}
