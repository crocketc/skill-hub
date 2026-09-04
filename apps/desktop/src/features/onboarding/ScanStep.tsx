import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { ScanResult } from "../../api/bindings";

interface ScanStepProps {
  isScanning: boolean;
  onScan: () => void;
  onContinueInBackground?: () => void;
  onOpenImport?: (roots: string[]) => void;
  scanResult?: ScanResult;
  scanInBackground?: boolean;
}

export function ScanStep({
  isScanning,
  onContinueInBackground,
  onOpenImport,
  onScan,
  scanInBackground = false,
  scanResult,
}: ScanStepProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="scan-step-title" className="sh-onboarding__card">
      <span className="sh-onboarding__ordinal">3</span>
      <h1 id="scan-step-title">{t("onboarding.scanTitle")}</h1>
      <p>{t("onboarding.scanDescription")}</p>
      <Button disabled={scanInBackground} loading={isScanning} onClick={onScan}>
        {t("onboarding.startReadOnlyScan")}
      </Button>
      {scanInBackground ? <p role="status">{t("onboarding.scanBackground")}</p> : null}
      {isScanning && onContinueInBackground ? (
        <Button onClick={onContinueInBackground} variant="secondary">
          {t("onboarding.scanContinueInBackground")}
        </Button>
      ) : null}
      {scanResult ? (
        <section aria-labelledby="scan-preview-title" className="sh-onboarding__scan-preview">
          <h2 id="scan-preview-title">{t("onboarding.scanPreviewTitle")}</h2>
          <div className="sh-onboarding__scan-stats">
            <span>{t("onboarding.scanDiscovered", { count: scanResult.discovered.length })}</span>
            <span>{t("onboarding.scanVisited", { count: scanResult.visited_paths.length })}</span>
            <span>{t("onboarding.scanIssues", { count: scanResult.errors.length })}</span>
          </div>
          {scanResult.discovered.length > 0 ? (
            <ul className="sh-onboarding__scan-list">
              {scanResult.discovered.map((skill) => (
                <li key={skill.path}>
                  <strong>{skill.relative_path || skill.path}</strong>
                  <code>{skill.path}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("onboarding.scanNoSkills")}</p>
          )}
          {scanResult.errors.length > 0 ? (
            <details>
              <summary>{t("onboarding.scanIssueDetails")}</summary>
              <ul className="sh-onboarding__scan-list">
                {scanResult.errors.map((issue) => (
                  <li key={`${issue.path}:${issue.code}`}>
                    <code>{issue.path}</code>
                    <span>{issue.code}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {onOpenImport && scanResult.discovered.length > 0 ? (
            <Button onClick={() => onOpenImport(scanResult.roots)} variant="secondary">
              {t("onboarding.scanOpenImport")}
            </Button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
