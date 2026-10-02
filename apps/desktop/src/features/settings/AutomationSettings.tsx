import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { Switch } from "../../ui/Switch";
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
    <section aria-labelledby="settings-skill-automation" className="sh-settings-card">
      <h2 id="settings-skill-automation" tabIndex={-1}>{t("settings.automation.skillPolicyHeading")}</h2>
      <p>{t("settings.automation.skillPolicyUnavailable")}</p>
      <p className="sh-settings-note">{t("settings.automation.legacyPreferencesNote")}</p>
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
      <div className="sh-settings-form-actions">
        <Link className="sh-button sh-button--secondary sh-button--md" to="/library">{t("settings.automation.openSkillLibrary")}</Link>
        <Link className="sh-button sh-button--secondary sh-button--md" to="/projects">{t("settings.automation.openProjects")}</Link>
        <Link className="sh-button sh-button--ghost sh-button--md" to="/settings?section=appUpdate">{t("settings.automation.openAppUpdates")}</Link>
      </div>
    </section>
  );
}
