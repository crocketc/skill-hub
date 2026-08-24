import { useTranslation } from "react-i18next";

export interface BootstrapState {
  phase: "loading_local";
  locale: string;
}

interface AppProps {
  bootstrap: BootstrapState;
}

export function App({ bootstrap }: AppProps) {
  const { t } = useTranslation();

  return (
    <main lang={bootstrap.locale}>
      {bootstrap.phase === "loading_local" && <p>{t("dataState.loading")}</p>}
    </main>
  );
}
