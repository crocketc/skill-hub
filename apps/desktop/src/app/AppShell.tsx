import type { BootstrapSnapshot } from "../api/bindings";
import { useTranslation } from "react-i18next";
import { Sidebar } from "./Sidebar";

interface AppShellProps {
  snapshot: BootstrapSnapshot;
}

export function AppShell({ snapshot }: AppShellProps) {
  const { t } = useTranslation();

  return (
    <div className="sh-app-shell">
      <Sidebar />
      <section className="sh-app-shell__workspace">
        <header className="sh-app-shell__topbar">
          <span>SkillHub</span>
          <span className="sh-app-shell__verification" role="status">
            {t("appShell.verification")}
          </span>
        </header>
        <main className="sh-app-shell__content">
          <section aria-label={t("appShell.cachedData")} className="sh-app-shell__summary">
            <p>{t("appShell.cachedData")}</p>
            <strong>{snapshot.skill_count}</strong>
            <span>{t("appShell.skillCount")}</span>
          </section>
          <section className="sh-app-shell__placeholder">
            <h1>{t("navigation.overview")}</h1>
            <p>{t("appShell.placeholder")}</p>
          </section>
        </main>
      </section>
    </div>
  );
}
