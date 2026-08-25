import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { BootstrapGate } from "../features/bootstrap/BootstrapGate";
import { resolveLocale } from "../i18n";

export interface BootstrapState {
  phase: "loading_local";
  locale: string;
}

interface AppProps {
  bootstrap: BootstrapState;
}

function useDocumentLocale(fallbackLocale: string) {
  const { i18n, t } = useTranslation();
  const activeLocale = resolveLocale([
    i18n.resolvedLanguage ?? i18n.language ?? fallbackLocale,
  ]);

  useEffect(() => {
    document.documentElement.lang = activeLocale;
  }, [activeLocale]);

  return { activeLocale, t };
}

export function App({ bootstrap }: AppProps) {
  const { activeLocale, t } = useDocumentLocale(bootstrap.locale);

  return (
    <main lang={activeLocale}>
      {bootstrap.phase === "loading_local" ? <p>{t("dataState.loading")}</p> : null}
    </main>
  );
}

export function DesktopApp() {
  useDocumentLocale("en-US");
  return <BootstrapGate />;
}
