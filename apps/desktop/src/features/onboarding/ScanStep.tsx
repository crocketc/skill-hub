import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { ScanResult } from "../../api/bindings";
import { displayPath } from "../../platform/displayPath";

interface ScanStepProps {
  isScanning: boolean;
  /**
   * Omitted when the host wizard renders the scan trigger in its stable
   * footer (rediscovery); first-run onboarding keeps the in-body trigger.
   */
  onScan?: () => void;
  onContinueInBackground?: () => void;
  onOpenImport?: (roots: string[]) => void;
  scanResult?: ScanResult;
  scanInBackground?: boolean;
  scanStartedAt?: number;
  scanPhase?: string;
  scanProgress?: { completed: number; total: number };
}

export function ScanStep({
  isScanning,
  onContinueInBackground,
  onOpenImport,
  onScan,
  scanInBackground = false,
  scanStartedAt,
  scanPhase,
  scanProgress,
  scanResult,
}: ScanStepProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isScanning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isScanning]);

  const elapsedSeconds = Math.max(0, Math.floor((now - (scanStartedAt ?? now)) / 1000));
  const hasKnownTotal = Boolean(scanProgress && scanProgress.total > 0);

  return (
    <section aria-labelledby="scan-step-title" className="sh-onboarding__card">
      <h1 id="scan-step-title">{t("onboarding.scanTitle")}</h1>
      <p>{t("onboarding.scanDescription")}</p>
      {onScan ? (
        <Button disabled={scanInBackground} loading={isScanning} onClick={onScan}>
          {isScanning ? t("onboarding.scanning") : t("onboarding.startReadOnlyScan")}
        </Button>
      ) : null}
      {isScanning ? (
        <section aria-label={t("onboarding.scanProgressTitle")} className="sh-onboarding__scan-progress">
          <div className="sh-onboarding__scan-progress-meta">
            <span>{t("onboarding.scanPhase", { phase: scanPhase ?? t("onboarding.scanPhaseScanning") })}</span>
            <span>{t("onboarding.scanElapsed", { seconds: elapsedSeconds })}</span>
          </div>
          <progress
            aria-label={t("onboarding.scanProgressTitle")}
            max={hasKnownTotal ? scanProgress!.total : undefined}
            value={hasKnownTotal ? scanProgress!.completed : undefined}
          />
          {!hasKnownTotal ? <p>{t("onboarding.scanProgressUnavailable")}</p> : null}
        </section>
      ) : null}
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
          {onOpenImport && scanResult.discovered.length > 0 ? (
            <div className="sh-onboarding__scan-actions">
              <Button onClick={() => onOpenImport(scanResult.roots)} variant="secondary">
                {t("onboarding.scanOpenImport")}
              </Button>
            </div>
          ) : null}
          <div className="sh-onboarding__scan-scroll">
            {scanResult.discovered.length > 0 ? (
              <ul className="sh-onboarding__scan-list">
                {scanResult.discovered.map((skill) => (
                  <li key={skill.path}>
                    <strong>{skill.relative_path || skill.path}</strong>
                    <code>{displayPath(skill.path)}</code>
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
                      <code>{displayPath(issue.path)}</code>
                      <span>{issue.code}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}
