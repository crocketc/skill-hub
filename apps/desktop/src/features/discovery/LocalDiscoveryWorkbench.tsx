import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { BrandTag } from "../../ui/BrandTag";
import { AgentKindBadge } from "../../ui/AgentKindBadge";
import type { DiscoverySnapshot, DiscoveredSkill } from "../../api/bindings";
import {
  buildAgentGroups,
  classifyScan,
  formatObservedAt,
  parseObservedAt,
  type AgentBrandGroup,
  type AgentTargetCard,
  type DiscoveryFacade,
  type ScanClassification,
} from "./api";

export interface LocalDiscoveryWorkbenchProps {
  facade: DiscoveryFacade;
  /** C3 收口：待导入横幅的"审查"入口；未提供时横幅不渲染动作按钮。 */
  onReviewCandidates?: (candidates: DiscoveredSkill[]) => void;
}

interface SnapshotState {
  observedAt: string;
  clients: number;
  targets: number;
  raw: DiscoverySnapshot;
}

/**
 * FE-07: local discovery workbench. Read-only: it only queries the discovery
 * snapshot, triggers scans through the existing `scan_targets` contract, and
 * classifies the results. It never writes records or directories.
 * P1-06：新增"发现的 Agent 目录"分组区（品牌分组 / 类型徽标 / 不可用置底 /
 * 同目录合并），以及只通过忽略规则实现的安全排除——绝不删除用户文件。
 */
export function LocalDiscoveryWorkbench({ facade, onReviewCandidates }: LocalDiscoveryWorkbenchProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null);
  const [classification, setClassification] = useState<ScanClassification | null>(null);
  // P1-04：保留本次扫描候选，"审查并导入"必须原样带给导入向导。
  const [candidates, setCandidates] = useState<DiscoveredSkill[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P1-06：安全排除——成功后从本次结果移除；规则可在设置中撤销。
  const [excludedPaths, setExcludedPaths] = useState<Set<string>>(new Set());
  const [excludedNotice, setExcludedNotice] = useState<string | null>(null);
  const [excludeError, setExcludeError] = useState<string | null>(null);
  // M-18：Agent 目录盘点是可折叠次级区；默认展开保持既有语义可见，
  // 折叠只影响展示，不改变分组/置底/排除行为。
  const [inventoryOpen, setInventoryOpen] = useState(true);

  const describeError = useCallback(
    (reason: unknown, genericKey: string) =>
      describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        genericKey,
      ),
    [t],
  );

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
          raw: result,
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
        raw: snap,
      });
      setClassification(classifyScan(snap, result));
      setCandidates(result.discovered);
    } catch {
      setError(t("discovery.workbench.scanFailed"));
    } finally {
      setScanning(false);
    }
  }, [facade, t]);

  // P1-06：分组派生保持纯函数；排除过的目录从展示中移除。
  const agentGroups = useMemo(() => {
    if (!snapshot) return null;
    const groups = buildAgentGroups(snapshot.raw, { os: detectOs() });
    const visible = (group: AgentBrandGroup): AgentBrandGroup => ({
      ...group,
      cards: group.cards.filter((card) => !excludedPaths.has(card.path)),
    });
    const dropEmpty = (list: AgentBrandGroup[]) =>
      list.map(visible).filter((group) => group.cards.length > 0);
    return {
      available: dropEmpty(groups.available),
      unavailable: dropEmpty(groups.unavailable),
    };
  }, [snapshot, excludedPaths]);

  const exclude = useCallback(
    async (path: string) => {
      setExcludeError(null);
      try {
        await facade.createIgnoreRule(path);
        setExcludedPaths((current) => new Set(current).add(path));
        setExcludedNotice(t("discovery.workbench.excludedNotice", { path }));
      } catch (reason) {
        setExcludeError(describeError(reason, "discovery.workbench.excludeFailed"));
      }
    },
    [describeError, facade, t],
  );

  const renderGroup = (group: AgentBrandGroup) => (
    <li className="sh-discovery-workbench__agent-group" key={group.brand}>
      <ul className="sh-discovery-workbench__agent-cards">
        {group.cards.map((card) => (
          <AgentCard
            card={card}
            brand={group.brand}
            exclude={exclude}
            key={`${group.brand}:${card.physicalId}`}
          />
        ))}
      </ul>
    </li>
  );

  // M-18：首屏工作区面板承载扫描/摘要/审查并导入；Agent 目录盘点降级为
  // 可折叠次级区，长列表在内部滚动所有者中滚动，不把操作推出首屏。
  const agentGroupTotal = agentGroups
    ? [...agentGroups.available, ...agentGroups.unavailable]
      .reduce((total, group) => total + group.cards.length, 0)
    : 0;

  return (
    <section aria-label={t("discovery.workbench.title")} aria-busy={scanning} className="sh-discovery-workbench">
      <div className="sh-discovery-workbench__panel">
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
        <div className="sh-discovery-workbench__actions">
          <Button disabled={scanning} onClick={() => void rescan()} variant="secondary">
            {scanning ? t("discovery.workbench.scanning") : t("discovery.workbench.rescan")}
          </Button>
        </div>
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
      </div>
      {agentGroups && agentGroupTotal > 0 ? (
        <div className="sh-discovery-workbench__inventory" data-testid="agent-groups">
          <div className="sh-discovery-workbench__inventory-header">
            <h4>{t("discovery.workbench.agentGroupsTitle")}</h4>
            <span className="sh-discovery-workbench__inventory-count">
              {t("discovery.workbench.agentGroupsCount", { count: agentGroupTotal })}
            </span>
            <Button
              aria-controls="sh-discovery-agent-inventory"
              aria-expanded={inventoryOpen}
              onClick={() => setInventoryOpen((open) => !open)}
              size="sm"
              variant="ghost"
            >
              {inventoryOpen
                ? t("discovery.workbench.agentGroupsCollapse")
                : t("discovery.workbench.agentGroupsExpand")}
            </Button>
          </div>
          <div
            className="sh-discovery-workbench__inventory-scroll"
            hidden={!inventoryOpen}
            id="sh-discovery-agent-inventory"
          >
            <ul aria-label={t("discovery.workbench.agentGroupsTitle")} className="sh-discovery-workbench__agent-groups">
              {agentGroups.available.map(renderGroup)}
            </ul>
            {agentGroups.unavailable.length > 0 ? (
              <div className="sh-discovery-workbench__agent-unavailable">
                <p>{t("discovery.workbench.unavailableAgents")}</p>
                <ul className="sh-discovery-workbench__agent-groups">
                  {agentGroups.unavailable.map(renderGroup)}
                </ul>
              </div>
            ) : null}
            {excludedNotice ? <p role="status">{excludedNotice}</p> : null}
            {excludeError ? <p role="alert">{excludeError}</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * P1-06：单张聚合卡片——品牌标签、去重类型徽标、目录路径与可用状态；
 * "排除"只通过忽略规则（可撤销）实现，绝不提供删除用户文件的入口。
 */
function AgentCard({
  brand,
  card,
  exclude,
}: {
  brand: string;
  card: AgentTargetCard;
  exclude: (path: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <li className="sh-discovery-workbench__agent-card" data-testid={`agent-card-${card.physicalId}`}>
      <div className="sh-discovery-workbench__agent-line">
        <BrandTag brand={brand} />
        <AgentKindBadge kinds={card.kinds} />
        {!card.available ? (
          <span className="sh-discovery-workbench__agent-unavailable-label">
            {t("discovery.workbench.agentUnavailable")}
          </span>
        ) : null}
      </div>
      {/* P2-02：超长路径换行展示（overflow-wrap: anywhere），完整值经原生
          title 提示可达——与忽略项规则值和卡片描述同一策略。 */}
      <code className="sh-discovery-workbench__agent-path" title={card.path}>{card.path}</code>
      <ConfirmDialog
        cancelLabel={t("actions.cancel")}
        confirmLabel={t("discovery.workbench.excludeConfirm")}
        description={t("discovery.workbench.excludeConfirmDescription", { path: card.path })}
        onConfirm={() => void exclude(card.path)}
        title={t("discovery.workbench.excludeConfirmTitle")}
        trigger={
          <Button size="sm" variant="ghost">
            {t("discovery.workbench.excludeAction")}
          </Button>
        }
        variant="primary"
      />
    </li>
  );
}

/**
 * P1-04：本地化展示扫描时间。observed_at 可能是 ISO、epoch 秒串或
 * 无法解析的脏数据——前两者渲染为 `<time>`，后者显示明确占位而非
 * 原始串。
 */
function renderObservedAt(
  observedAt: string,
  t: (key: "discovery.workbench.timeUnknown") => string,
): JSX.Element {
  const date = parseObservedAt(observedAt);
  const label = formatObservedAt(observedAt);
  if (!date || !label) {
    return <span>{t("discovery.workbench.timeUnknown")}</span>;
  }
  return <time dateTime={date.toISOString()}>{label}</time>;
}

/** 快照按当前宿主 OS 过滤 profile 的 supported_os；未知环境回退 windows。 */
function detectOs(): "windows" | "macos" {
  if (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "")) {
    return "macos";
  }
  return "windows";
}
