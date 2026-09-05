import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import {
  classifyScan,
  formatObservedAt,
  type DiscoveryFacade,
  type ScanClassification,
} from "./api";

export interface LocalDiscoveryWorkbenchProps {
  facade: DiscoveryFacade;
}

interface SnapshotState {
  observedAt: string;
  clients: number;
  targets: number;
}

/**
 * FE-07: local discovery workbench. Read-only: it only queries the discovery
 * snapshot, triggers scans through the existing `scan_targets` contract, and
 * classifies the results. It never writes records or directories.
 */
export function LocalDiscoveryWorkbench({ facade }: LocalDiscoveryWorkbenchProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null);
  const [classification, setClassification] = useState<ScanClassification | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    facade
      .getDiscoverySnapshot()
      .then((result) => {
        if (cancelled) return;
        setSnapshot({
          observedAt: result.observed_at,
          clients: result.instances.length,
          targets: result.physical_targets.length,
        });
      })
      .catch(() => {
        if (!cancelled) setError(t("discovery.workbench.unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [facade, t]);

  const rescan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await facade.scanTargets([]);
      const snap = await facade.getDiscoverySnapshot();
      setSnapshot({
        observedAt: snap.observed_at,
        clients: snap.instances.length,
        targets: snap.physical_targets.length,
      });
      setClassification(classifyScan(snap, result));
    } catch {
      setError(t("discovery.workbench.scanFailed"));
    } finally {
      setScanning(false);
    }
  }, [facade, t]);

  return (
    <section aria-label={t("discovery.workbench.title")} className="sh-discovery-workbench">
      <h3>{t("discovery.workbench.title")}</h3>
      {snapshot ? (
        <p>
          {t("discovery.workbench.lastScan")}
          {" "}
          <time dateTime={snapshot.observedAt}>{formatObservedAt(snapshot.observedAt)}</time>
        </p>
      ) : null}
      {snapshot ? (
        <p>{t("discovery.workbench.scope", { clients: snapshot.clients, targets: snapshot.targets })}</p>
      ) : null}
      <Button disabled={scanning} onClick={() => void rescan()} variant="secondary">
        {scanning ? t("discovery.workbench.scanning") : t("discovery.workbench.rescan")}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {classification ? (
        <ul className="sh-discovery-workbench__categories">
          <li title={t("discovery.workbench.unmanagedHint")}>
            {t("discovery.workbench.unmanaged", { count: classification.unmanaged })}
          </li>
          <li title={t("discovery.workbench.relatedHint")}>
            {t("discovery.workbench.related", { count: classification.related })}
          </li>
          <li title={t("discovery.workbench.conflictHint")}>
            {t("discovery.workbench.conflict", { count: classification.conflict })}
          </li>
          <li title={t("discovery.workbench.suspectedHint")}>
            {t("discovery.workbench.suspected", { count: classification.suspected })}
          </li>
          <li title={t("discovery.workbench.unreadableHint")}>
            {t("discovery.workbench.unreadable", { count: classification.unreadable })}
          </li>
        </ul>
      ) : null}
    </section>
  );
}
