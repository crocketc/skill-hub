import { useTranslation } from "react-i18next";
import type { RouteTitleKey } from "./AppShell";

interface RoutePlaceholderProps {
  titleKey: RouteTitleKey;
}

export function RoutePlaceholder({ titleKey }: RoutePlaceholderProps) {
  const { t } = useTranslation();

  return (
    <section className="sh-app-shell__placeholder">
      <h2>{t(titleKey)}</h2>
      <p>{t("appShell.placeholder")}</p>
    </section>
  );
}
