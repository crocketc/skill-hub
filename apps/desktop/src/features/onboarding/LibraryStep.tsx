import { useTranslation } from "react-i18next";

interface LibraryStepProps {
  libraryPath?: string;
}

export function LibraryStep({ libraryPath }: LibraryStepProps) {
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
    </section>
  );
}
