import { useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocale } from "../../i18n";
import { Field } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { ThemeChoiceGrid } from "../../styles/ThemeChoiceGrid";
import { useTheme } from "../../styles/ThemeProvider";
import type { AppearancePreference, ThemeName } from "../../styles/theme";
import { setUserReducedMotion, useUserReducedMotion } from "../../ui/reducedMotion";
import { Switch } from "../../ui/Switch";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
import type { SettingsFacade, SettingsSnapshot } from "./api";

function resolvedLanguage(language: SettingsSnapshot["appearance"]["language"]) {
  if (language !== "system") return language;
  return resolveLocale(navigator.languages ?? [navigator.language]);
}

export function GeneralSettings({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { i18n, t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const { appearance, resolvedTheme, setAppearance } = useTheme();
  const [language, setLanguage] = useState(settings.appearance.language);
  const [error, setError] = useState<string>();
  const userReducedMotion = useUserReducedMotion();
  const selectAppearance = (theme: AppearancePreference) => {
    const previous = appearance;
    setAppearance(theme);
    setError(undefined);
    void runTrackedOperation({
      kind: "settings_theme",
      label: t("settings.general.appearance"),
      mode: "instant",
      notifications,
      translate: (name, options) => t(name as never, options),
      successNotice: () => ({ tone: "success", title: t("settings.general.themeSaved") }),
      errorNotice: (_error, message) => ({ tone: "danger", title: t("settings.general.themeSaveError"), detail: message }),
      run: () => facade.execute({ type: "set_theme", payload: { theme } }),
    }).catch(() => {
      setAppearance(previous);
      setError(t("settings.general.themeSaveError"));
    });
  };
  const selectTheme = (theme: ThemeName) => selectAppearance(theme);

  const selectLanguage = (next: SettingsSnapshot["appearance"]["language"]) => {
    const previous = language;
    setLanguage(next);
    setError(undefined);
    void i18n.changeLanguage(resolvedLanguage(next));
    void runTrackedOperation({
      kind: "settings_language",
      label: t("settings.general.heading"),
      mode: "instant",
      notifications,
      translate: (name, options) => t(name as never, options),
      successNotice: () => ({ tone: "success", title: t("settings.general.languageSaved") }),
      errorNotice: (_error, message) => ({ tone: "danger", title: t("settings.general.languageSaveError"), detail: message }),
      run: () => facade.execute({ type: "set_language", payload: { language: next } }),
    }).catch(() => {
      setLanguage(previous);
      void i18n.changeLanguage(resolvedLanguage(previous));
      setError(t("settings.general.languageSaveError"));
    });
  };

  return <section className="sh-settings-card">
    <h2>{t("settings.general.groupHeading")}</h2>
      <Field help={t("settings.general.languageDescription")} id="settings-language" label={t("settings.general.language")}>
      <Select
        onChange={(event) => selectLanguage(event.target.value as SettingsSnapshot["appearance"]["language"])}
        value={language}
      >
        <option value="system">{t("settings.general.languages.system")}</option>
        <option value="zh-CN">{t("settings.general.languages.zhCN")}</option>
        <option value="en-US">{t("settings.general.languages.enUS")}</option>
      </Select>
    </Field>
    <Field help={t("settings.general.appearanceDescription")} id="settings-appearance" label={t("settings.general.appearance")}>
      <Select onChange={(event) => selectAppearance(event.target.value as AppearancePreference)} value={appearance}>
        <option value="system">{t("settings.general.appearances.system")}</option>
        <option value="light">{t("settings.general.appearances.light")}</option>
        <option value="dark">{t("settings.general.appearances.dark")}</option>
      </Select>
    </Field>
    <div className="sh-settings-theme-row">
      <div className="sh-settings-theme-row__copy">
        <span>{t("settings.general.theme")}</span>
        <p className="sh-field__help">{t("settings.general.themeDescription")}</p>
      </div>
      <ThemeChoiceGrid onChange={selectTheme} value={resolvedTheme} />
    </div>
    <div className="sh-settings-toggle">
      <Switch
        checked={userReducedMotion}
        describedBy="settings-reduced-motion-help"
        id="settings-reduced-motion"
        label={t("settings.general.reducedMotion")}
        name="reduced-motion"
        onChange={(event) => setUserReducedMotion(event.target.checked)}
      />
    </div>
    <p className="sh-field__help" id="settings-reduced-motion-help">
      {t("settings.general.reducedMotionDescription")}
    </p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
