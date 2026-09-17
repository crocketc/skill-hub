import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
import type { SettingsFacade, SettingsSnapshot } from "./api";

export function ViewSettings({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const [density, setDensity] = useState(settings.view.density);
  const [error, setError] = useState(false);
  const selectDensity = (next: SettingsSnapshot["view"]["density"]) => {
    const previous = density;
    setDensity(next);
    setError(false);
    void runTrackedOperation({
      kind: "settings_view",
      label: t("settings.view.heading"),
      mode: "instant",
      notifications,
      translate: (name, options) => t(name as never, options),
      successNotice: () => ({ tone: "success", title: t("settings.view.saved") }),
      errorNotice: (_error, message) => ({ tone: "danger", title: t("settings.view.saveFailed"), detail: message }),
      run: () => facade.execute({ type: "set_density", payload: { density: next } }),
    }).catch(() => {
      setDensity(previous);
      setError(true);
    });
  };
  return (
    <section className="sh-settings-card">
      <h2>{t("settings.view.heading")}</h2>
      <Field
        help={t("settings.view.density", { density: t(`settings.view.densities.${density}`) })}
        label={t("settings.view.densityLabel")}
      >
        <Select
          onChange={(event) => selectDensity(event.target.value as SettingsSnapshot["view"]["density"])}
          value={density}
        >
          <option value="compact">{t("settings.view.densities.compact")}</option>
          <option value="standard">{t("settings.view.densities.standard")}</option>
          <option value="comfortable">{t("settings.view.densities.comfortable")}</option>
        </Select>
      </Field>
      {error ? <p role="alert">{t("settings.view.saveFailed")}</p> : null}
    </section>
  );
}
