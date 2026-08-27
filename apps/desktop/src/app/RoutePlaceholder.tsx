import { useTranslation } from "react-i18next";
import type { RouteTitleKey } from "./AppShell";

interface RoutePlaceholderProps {
  descriptionKey?: "appShell.placeholder" | "skillLibrary.fullDetailsBoundary";
  titleKey: RouteTitleKey;
}

export function RoutePlaceholder({
  descriptionKey = "appShell.placeholder",
  titleKey,
}: RoutePlaceholderProps) {
  const { t } = useTranslation();

  return (
    <section className="sh-app-shell__placeholder">
      <h2>{t(titleKey)}</h2>
      <p>{t(descriptionKey)}</p>
    </section>
  );
}
