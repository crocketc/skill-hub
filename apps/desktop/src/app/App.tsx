import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocale } from "../i18n";

export interface BootstrapState {
  phase: "loading_local";
  locale: string;
}

interface AppProps {
  bootstrap: BootstrapState;
}

export function App({ bootstrap }: AppProps) {
  const { i18n, t } = useTranslation();
  const activeLocale = resolveLocale([
    i18n.resolvedLanguage ?? i18n.language ?? bootstrap.locale,
  ]);

  useEffect(() => {
    document.documentElement.lang = activeLocale;
  }, [activeLocale]);

  return (
    <main lang={activeLocale}>
      {bootstrap.phase === "loading_local" && <p>{t("dataState.loading")}</p>}
    </main>
  );
}
