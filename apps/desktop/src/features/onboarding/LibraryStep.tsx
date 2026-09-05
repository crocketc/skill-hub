import { useTranslation } from "react-i18next";
import { ThemeChoiceGrid } from "../../styles/ThemeChoiceGrid";
import type { ThemeName } from "../../styles/theme";

interface LibraryStepProps {
  libraryPath?: string;
  onThemeChange: (theme: ThemeName) => void;
  theme: ThemeName;
}

export function LibraryStep({ libraryPath, onThemeChange, theme }: LibraryStepProps) {
  const { t } = useTranslation();

  if (!libraryPath) {
    return (
      <section aria-labelledby="library-step-title" className="sh-onboarding__card">
        <span className="sh-onboarding__ordinal">1</span>
        <h1 id="library-step-title">{t("onboarding.pathUnavailableTitle")}</h1>
        <p>{t("onboarding.pathUnavailableDescription")}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="library-step-title" className="sh-onboarding__card">
      <span className="sh-onboarding__ordinal">1</span>
      <h1 id="library-step-title">{t("onboarding.libraryTitle")}</h1>
      <p>{t("onboarding.libraryDescription")}</p>
      <div className="sh-onboarding__path">
        <span>{t("onboarding.defaultLocation")}</span>
        <code>{libraryPath}</code>
      </div>
      <p className="sh-onboarding__helper">{t("onboarding.libraryHelper")}</p>
      <section aria-labelledby="onboarding-theme-title">
        <h2 id="onboarding-theme-title">{t("onboarding.themeTitle")}</h2>
        <p>{t("onboarding.themeDescription")}</p>
        <ThemeChoiceGrid onChange={onThemeChange} value={theme} />
      </section>
    </section>
  );
}
