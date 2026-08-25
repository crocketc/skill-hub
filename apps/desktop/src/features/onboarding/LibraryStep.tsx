import { useTranslation } from "react-i18next";

interface LibraryStepProps {
  defaultLibraryPath: string;
}

export function LibraryStep({ defaultLibraryPath }: LibraryStepProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="library-step-title" className="sh-onboarding__card">
      <span className="sh-onboarding__ordinal">1</span>
      <h1 id="library-step-title">{t("onboarding.libraryTitle")}</h1>
      <p>{t("onboarding.libraryDescription")}</p>
      <div className="sh-onboarding__path">
        <span>{t("onboarding.defaultLocation")}</span>
        <code>{defaultLibraryPath}</code>
      </div>
      <p className="sh-onboarding__helper">{t("onboarding.libraryHelper")}</p>
    </section>
  );
}
