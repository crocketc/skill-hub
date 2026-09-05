import { useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocale } from "../../i18n";
import { ThemeChoiceGrid } from "../../styles/ThemeChoiceGrid";
import { useTheme } from "../../styles/ThemeProvider";
import type { ThemeName } from "../../styles/theme";
import type { SettingsFacade, SettingsSnapshot } from "./api";

function resolvedLanguage(language: SettingsSnapshot["appearance"]["language"]) {
  if (language !== "system") return language;
  return resolveLocale(navigator.languages ?? [navigator.language]);
}

export function GeneralSettings({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { i18n, t } = useTranslation();
  const { appearance, resolvedTheme, setAppearance } = useTheme();
  const [language, setLanguage] = useState(settings.appearance.language);
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

  const selectLanguage = (next: SettingsSnapshot["appearance"]["language"]) => {
    const previous = language;
    setLanguage(next);
    setError(undefined);
    void i18n.changeLanguage(resolvedLanguage(next));
    void facade.execute({ type: "set_language", payload: { language: next } }).catch(() => {
      setLanguage(previous);
      void i18n.changeLanguage(resolvedLanguage(previous));
      setError(t("settings.general.languageSaveError"));
    });
  };

  return <section className="sh-settings-card">
    <h2>{t("settings.general.heading")}</h2>
    <label>
      {t("settings.general.language")}
      <select onChange={(event) => selectLanguage(event.target.value as SettingsSnapshot["appearance"]["language"])} value={language}>
        <option value="system">{t("settings.general.languages.system")}</option>
        <option value="zh-CN">{t("settings.general.languages.zhCN")}</option>
        <option value="en-US">{t("settings.general.languages.enUS")}</option>
      </select>
    </label>
    <p>{t("settings.general.languageDescription")}</p>
    <dl className="sh-facts"><dt>{t("settings.general.theme")}</dt><dd>{resolvedTheme}</dd></dl>
    <p>{t("settings.general.themeDescription")}</p>
    <ThemeChoiceGrid onChange={selectTheme} value={resolvedTheme} />
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
