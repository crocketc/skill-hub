import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsFacade, SettingsSnapshot } from "./api";

export function ViewSettings({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { t } = useTranslation();
  const [density, setDensity] = useState(settings.view.density);
  const [error, setError] = useState(false);
  const selectDensity = (next: SettingsSnapshot["view"]["density"]) => {
    const previous = density;
    setDensity(next);
    setError(false);
    void facade.execute({ type: "set_density", payload: { density: next } }).catch(() => {
      setDensity(previous);
      setError(true);
    });
  };
  return <section className="sh-settings-card"><h2>{t("settings.view.heading")}</h2><label>{t("settings.view.densityLabel")}<select onChange={(event) => selectDensity(event.target.value as SettingsSnapshot["view"]["density"])} value={density}><option value="compact">{t("settings.view.densities.compact")}</option><option value="standard">{t("settings.view.densities.standard")}</option><option value="comfortable">{t("settings.view.densities.comfortable")}</option></select></label><p>{t("settings.view.density", { density: t(`settings.view.densities.${density}`) })}</p>{error ? <p role="alert">{t("settings.view.saveFailed")}</p> : null}</section>;
}
