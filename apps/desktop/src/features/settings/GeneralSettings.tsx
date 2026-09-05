import { useTranslation } from "react-i18next";
import { useState } from "react";
import { ThemeChoiceGrid } from "../../styles/ThemeChoiceGrid";
import { useTheme } from "../../styles/ThemeProvider";
import type { ThemeName } from "../../styles/theme";
import type { SettingsFacade, SettingsSnapshot } from "./api";

export function GeneralSettings({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { t } = useTranslation();
  const { appearance, resolvedTheme, setAppearance } = useTheme();
  const [error, setError] = useState<string>();
  const selectTheme = (theme: ThemeName) => {
    const previous = appearance;
    setAppearance(theme);
    setError(undefined);
    void facade.execute({ type: "set_theme", payload: { theme } }).catch(() => {
      setAppearance(previous);
      setError(t("settings.general.themeSaveError"));
    });
  };
  return <section className="sh-settings-card"><h2>{t("settings.general.heading")}</h2><dl className="sh-facts"><dt>{t("settings.general.language")}</dt><dd>{settings.appearance.language}</dd><dt>{t("settings.general.theme")}</dt><dd>{resolvedTheme}</dd></dl><p>{t("settings.general.themeDescription")}</p><ThemeChoiceGrid onChange={selectTheme} value={resolvedTheme} />{error ? <p role="alert">{error}</p> : null}</section>;
}
