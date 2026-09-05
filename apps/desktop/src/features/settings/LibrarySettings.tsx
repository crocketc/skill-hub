import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { HealthFinding, HealthReport } from "../../api/bindings";
import { Button } from "../../ui/Button";
import { type LibraryHealthOperations, type SettingsSnapshot } from "./api";

export interface LibrarySettingsProps {
  settings: SettingsSnapshot;
  /** When provided, the card renders the library health check entry. */
  health?: LibraryHealthOperations;
}

type SeverityKey =
  | "settings.library.severityCritical"
  | "settings.library.severityError"
  | "settings.library.severityWarning"
  | "settings.library.severityInfo";

function severityKey(severity: HealthFinding["severity"]): SeverityKey {
  switch (severity) {
    case "critical":
      return "settings.library.severityCritical";
    case "error":
      return "settings.library.severityError";
    case "warning":
      return "settings.library.severityWarning";
    default:
      return "settings.library.severityInfo";
  }
}

export function LibrarySettings({ settings, health }: LibrarySettingsProps) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCheck = async () => {
    if (!health) return;
    setChecking(true);
    setError(null);
    try {
      setReport(await health.runHealthCheck());
    } catch {
      setError(t("settings.library.checkFailed"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="sh-settings-card">
      <h2>{t("settings.library.heading")}</h2>
      <dl className="sh-facts">
        <dt>{t("settings.library.path")}</dt>
        <dd>{settings.library.path}</dd>
      </dl>
      {settings.library.migrationAvailable ? (
        <p className="sh-settings-note">{t("settings.library.migrationAvailable")}</p>
      ) : null}
      {health ? (
        <div className="sh-settings-card__health">
          <Button disabled={checking} onClick={() => void runCheck()} variant="secondary">
            {checking ? t("settings.library.checking") : t("settings.library.runHealthCheck")}
          </Button>
          {error ? <p role="alert">{error}</p> : null}
          {report && !error ? (
            report.findings.length === 0 ? (
              <p>{t("settings.library.allClear")}</p>
            ) : (
              <>
                <p>{t("settings.library.findingsSummary", { count: report.findings.length })}</p>
                <ul>
                  {report.findings.map((finding, index) => (
                    <li key={`${report.id}:${index}`}>
                      <span>{finding.code}</span>
                      <span>{t(severityKey(finding.severity))}</span>
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
