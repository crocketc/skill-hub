import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { desktopDirectoryPicker, type DirectoryPicker } from "../../platform/directoryPicker";
import { onDeploymentFactsChanged } from "../../platform/deploymentEvents";
import { onDiscoveryFactsChanged } from "../../platform/discoveryEvents";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { AgentPresentation } from "../../ui/AgentPresentation";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Drawer } from "../../ui/Drawer";
import { PageHeader } from "../../ui/PageHeader";
import { StatusBadge } from "../../ui/StatusBadge";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { type AgentFacade, type AgentView, unavailableAgentFacade } from "./api";
import { buildAgentCardViews, normalizePathKey } from "./agentCards";
import { CustomAgentForm } from "./CustomAgentForm";
import "./agents.css";
import { displayPath } from "../../platform/displayPath";

export interface AgentListPageProps {
  facade?: AgentFacade;
  picker?: DirectoryPicker;
  /** 统一执行桥的在途投影；测试可注入独立 tracker。 */
  tracker?: OperationTracker;
}

type CustomAgentFormState = { mode: "create" } | { agent: AgentView; mode: "edit" };

export function AgentListPage({
  facade = unavailableAgentFacade,
  picker = desktopDirectoryPicker,
  tracker = operationTracker,
}: AgentListPageProps) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const [agents, setAgents] = useState<AgentView[]>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [formState, setFormState] = useState<CustomAgentFormState>();
  const [revision, setRevision] = useState(0);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    void facade.list().then((value) => {
      if (active) setAgents(value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    });
    return () => { active = false; };
  }, [facade, revision, t]);

  // DEV-22：部署提交成功后 Agent 卡片的 Skill/部署关系计数必须即时刷新
  // （本页是本地 state 拉取，没有可失效的 query key，靠应用内广播触发重读）。
  useEffect(() => onDeploymentFactsChanged(() => {
    setRevision((current) => current + 1);
  }), []);

  // 启动后台 Agent 重扫发现新品牌/类型后广播：本页重读快照，让新卡片即时出现。
  useEffect(() => onDiscoveryFactsChanged(() => {
    setRevision((current) => current + 1);
  }), []);

  // 2026-09-25 验收反馈：卡片整页平铺。品牌分组标题在卡片自带品牌+
  // 类型标识后是冗余的，且分组网格每组只剩一两张卡，页面仍是纵向堆叠；
  // 拍平为单一网格后按品牌排序保持相邻。
  const cards = useMemo(
    () => [...buildAgentCardViews(agents ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, groupCards]) => groupCards),
    [agents],
  );
  // DEV-88：共享目录卡在页面里只有一张；品牌卡上的「支持共享目录」chip
  // 点击后定位到它。不存在时 chip 退化为纯标注（仍不显示具体路径）。
  const sharedCardId = cards.find(({ sharedDirectory }) => sharedDirectory)?.agent.id;

  const rescan = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      await runTrackedOperation({
        errorNotice: (_error, message) => ({ tone: "danger", title: t("agents.actions.rescan"), detail: message }),
        kind: "agent_rescan",
        label: t("agents.actions.rescan"),
        notifications,
        run: async () => {
          await facade.rescan();
        },
        source: "discovery",
        successNotice: () => ({ tone: "success", title: t("agents.actions.rescan") }),
        total: 1,
        tracker,
      });
      setRevision((current) => current + 1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    } finally {
      setRefreshing(false);
    }
  };

  const removeAgent = async (id: string) => {
    setError(undefined);
    try {
      await runTrackedOperation({
        kind: "agent_remove",
        label: t("agents.actions.remove"),
        mode: "instant",
        notifications,
        translate: (key, options) => String(t(key as never, options as never)),
        successNotice: () => ({ tone: "success", title: t("agents.actions.remove") }),
        errorNotice: (_error, message) => ({ tone: "danger", title: t("agents.actions.remove"), detail: message }),
        run: () => facade.removeCustomAgent(id),
      });
      setRevision((current) => current + 1);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    }
  };

  if (error) {
    return (
      <DataState
        actionLabel={t("agents.actions.rescan")}
        message={t("agents.unavailable")}
        onAction={() => void rescan()}
        state="unavailable"
      />
    );
  }
  if (!agents) return <DataState message={t("agents.loading")} state="loading" />;

  return (
    <div className="sh-agents-page">
      <PageHeader
        actions={(
          <>
            <Button onClick={() => setFormState({ mode: "create" })} ref={drawerTriggerRef} variant="secondary">{t("agents.actions.addCustom")}</Button>
            <Button loading={refreshing} onClick={() => void rescan()} variant="secondary">{t("agents.actions.rescan")}</Button>
          </>
        )}
        description={t("agents.description")}
        headingLevel="h1"
        title={t("agents.title")}
      />
      {agents.length === 0 ? <DataState message={t("agents.empty")} state="empty" /> : (
        <ul aria-label={t("agents.title")} className="sh-agents-page__cards">
          {cards.map(({ agent, kinds, sharedDirectory, sharedPathKeys }) => (
              <li className="sh-agent-card" data-testid="agent-card" key={agent.id}>
                <div className="sh-agent-card__head">
                  {/* DEV-87（2026-09-25 验收反馈）：三标签融二——左侧为品牌
                      +类型与差异色「内置 · 只读」徽标，可访问状态徽标独占
                      右上角，与其他卡片位置一致。 */}
                  <div className="sh-agent-card__head-main">
                    <Link className="sh-agent-card__title" to={`/agents/${agent.id}`}>
                      <AgentPresentation
                        agentId={agent.client}
                        brand={agent.brand}
                        kinds={kinds}
                        sharedDirectory={sharedDirectory}
                      />
                    </Link>
                    {agent.builtin ? <span className="sh-agent-card__builtin">{t("agents.builtinLabel")}</span> : null}
                  </div>
                  <StatusBadge tone={statusTone(agent.status)}>{t(`agents.status.${agent.status}`)}</StatusBadge>
                </div>
                {agent.builtin ? (
                  <p className="sh-agent-card__builtin-hint">{t("agents.builtinHint")}</p>
                ) : null}
                <div className="sh-agent-card__paths">
                  <span className="sh-agent-card__paths-label">{t("agents.pathLabel")}</span>
                  <ul className="sh-agent-card__path-list">
                    {/* DEV-88（2026-09-25 验收反馈）：shared_reference 路径
                        不展示具体路径（唯一路径在共享目录卡上），替换为
                        「支持共享目录」chip，点击定位共享目录卡。 */}
                    {renderCardPaths({
                      agent,
                      sharedPathKeys,
                      sharedCardId,
                      label: t("agents.sharedDirectoryChip"),
                    })}
                  </ul>
                </div>
                <div className="sh-agent-card__meta">
                  <span>{[t("agents.managedSkillsCount", { count: agent.managedDeploymentCount }), t("agents.managedRelationsCount", { count: agent.managedDeploymentRelationCount })].join(" · ")}</span>
                </div>
                {agent.status === "custom" ? (
                  <div className="sh-agent-card__actions">
                    <Button
                      onClick={(event) => { drawerTriggerRef.current = event.currentTarget; setFormState({ agent, mode: "edit" }); }}
                      size="sm"
                      variant="secondary"
                    >
                      {t("agents.actions.edit")}
                    </Button>
                    <ConfirmDialog
                      cancelLabel={t("agents.removeDialog.cancel")}
                      confirmLabel={t("agents.removeDialog.confirm")}
                      description={t("agents.removeDialog.description", { name: agent.instance })}
                      onConfirm={() => void removeAgent(agent.id)}
                      title={t("agents.removeDialog.title")}
                      trigger={<Button size="sm" variant="danger">{t("agents.actions.remove")}</Button>}
                    />
                  </div>
                ) : null}
              </li>
            ))}
        </ul>
      )}
      <Drawer
        onOpenChange={(open) => { if (!open) setFormState(undefined); }}
        open={formState !== undefined}
        returnFocusRef={drawerTriggerRef}
        title={formState?.mode === "edit" ? t("agents.customForm.editTitle") : t("agents.customForm.addTitle")}
      >
        {formState ? (
          <CustomAgentForm
            agent={formState.mode === "edit" ? formState.agent : undefined}
            facade={facade}
            onCancel={() => setFormState(undefined)}
            onSaved={() => {
              setFormState(undefined);
              setRevision((current) => current + 1);
            }}
            picker={picker}
          />
        ) : null}
      </Drawer>
    </div>
  );
}


/**
 * DEV-88：卡片路径列表渲染——shared_reference 的路径行（按文件系统身份
 * 识别，合卡后可能有多条拼法变体）只渲染一枚「支持共享目录」chip；共享
 * 目录卡存在时 chip 可点击定位到它，具体路径只在共享目录卡上展示一次。
 */
function renderCardPaths({
  agent,
  label,
  sharedCardId,
  sharedPathKeys,
}: {
  agent: AgentView;
  label: string;
  sharedCardId: string | undefined;
  sharedPathKeys: string[];
}): JSX.Element[] {
  const shared = new Set(sharedPathKeys);
  const renderedShared = new Set<string>();
  const items: JSX.Element[] = [];
  for (const path of agent.discoveredPaths) {
    const key = normalizePathKey(path);
    if (shared.has(key)) {
      if (renderedShared.has(key)) continue;
      renderedShared.add(key);
      items.push(
        sharedCardId ? (
          <li key={`shared-${key}`}>
            <Link className="sh-agent-card__shared-chip" to={`/agents/${sharedCardId}`}>
              {label}
            </Link>
          </li>
        ) : (
          <li key={`shared-${key}`}>
            <span className="sh-agent-card__shared-chip">{label}</span>
          </li>
        ),
      );
      continue;
    }
    items.push(
      <li key={path}>
        <code className="sh-agent-card__path">{displayPath(path)}</code>
      </li>,
    );
  }
  return items;
}

function statusTone(status: AgentView["status"]): "info" | "neutral" | "success" | "warning" {
  if (status === "accessible") return "success";
  if (status === "inaccessible") return "warning";
  if (status === "custom") return "info";
  return "neutral";
}
