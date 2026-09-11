import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { DiscoveredSkill } from "../../api/bindings";
import {
  classifyScan,
  formatObservedAt,
  parseObservedAt,
  type DiscoveryFacade,
  type ScanClassification,
} from "./api";

export interface LocalDiscoveryWorkbenchProps {
  facade: DiscoveryFacade;
  /** C3 收口：待导入横幅的"审查"入口；未提供时横幅不渲染动作按钮。 */
  onReviewCandidates?: (candidates: DiscoveredSkill[]) => void;
}

/**
 * P1-04：本地化展示扫描时间。observed_at 可能是 ISO、epoch 秒串或
 * 无法解析的脏数据——前两者渲染为 `<time>`，后者显示明确占位而非
 * 原始串。
 */
function renderObservedAt(
  observedAt: string,
  t: (key: string) => string,
): JSX.Element {
  const date = parseObservedAt(observedAt);
  const label = formatObservedAt(observedAt);
  if (!date || !label) {
    return <span>{t("discovery.workbench.timeUnknown")}</span>;
  }
  return <time dateTime={date.toISOString()}>{label}</time>;
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
export function LocalDiscoveryWorkbench({ facade, onReviewCandidates }: LocalDiscoveryWorkbenchProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null);
  const [classification, setClassification] = useState<ScanClassification | null>(null);
  // P1-04：保留本次扫描候选，"审查并导入"必须原样带给导入向导。
  const [candidates, setCandidates] = useState<DiscoveredSkill[]>([]);
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
      setCandidates(result.discovered);
    } catch {
      setError(t("discovery.workbench.scanFailed"));
    } finally {
      setScanning(false);
    }
  }, [facade, t]);

  return (
    <section aria-label={t("discovery.workbench.title")} aria-busy={scanning} className="sh-discovery-workbench">
      <h3>{t("discovery.workbench.title")}</h3>
      {scanning ? <p role="status">{t("discovery.workbench.scanningStatus")}</p> : null}
      {snapshot ? (
        <p>
          {t("discovery.workbench.lastScan")}
          {" "}
          {renderObservedAt(snapshot.observedAt, t)}
        </p>
      ) : null}
      {snapshot ? (
        <p>{t("discovery.workbench.scope", { clients: snapshot.clients, targets: snapshot.targets })}</p>
      ) : null}
      <Button disabled={scanning} onClick={() => void rescan()} variant="secondary">
        {scanning ? t("discovery.workbench.scanning") : t("discovery.workbench.rescan")}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {classification && classification.unmanaged > 0 ? (
        <div className="sh-discovery-workbench__banner" role="status">
          <strong>{t("discovery.workbench.bannerHeading", { count: classification.unmanaged })}</strong>
          <small>{t("discovery.workbench.bannerHint")}</small>
          {onReviewCandidates ? (
            <Button onClick={() => onReviewCandidates(candidates)} variant="primary">
              {t("discovery.workbench.reviewAction")}
            </Button>
          ) : null}
        </div>
      ) : null}
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
