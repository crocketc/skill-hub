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
import { DataState } from "../../ui/DataState";
import { Drawer } from "../../ui/Drawer";
import { PageHeader } from "../../ui/PageHeader";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { type AgentFacade, type AgentDirectoryView, type AgentView, unavailableAgentFacade } from "./api";
import { buildAgentCardViews } from "./agentCards";
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
  const translate = (key: string, options?: Record<string, unknown>): string =>
    String(t(key as never, options as never));
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

  // 部署事实变化后重读目录视图，卡片只更新目录与能力图标，数量留在详情页。
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
          {cards.map(({ agent, kinds, sharedDirectory, model }) => (
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
                        sharedAgentBrands={model.sharedAgentBrands}
                        sharedAgentBrandKinds={model.sharedAgentBrandKinds}
                        sharedDirectory={sharedDirectory}
                      />
                    </Link>
                    {agent.builtin ? <span className="sh-agent-card__builtin">{t("agents.builtinLabel")}</span> : null}
                  </div>
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
                    {model.directories.map((directory, index) => renderDirectory(directory, index, translate))}
                  </ul>
                </div>
                {model.supportsSharedDirectory && !model.sharedDirectory ? (
                  <span className="sh-agent-card__shared-chip">{t("agents.sharedDirectoryChip")}</span>
                ) : null}
                <DeploymentCapabilityIcons directory={model.directories[0]} t={translate} />
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
function renderDirectory(
  directory: AgentDirectoryView,
  index: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): JSX.Element {
  const content = directory.status === "pending_creation"
    ? t("agents.pathPending")
    : directory.path
      ? displayPath(directory.path)
      : t("agents.pathUnavailable");
  return (
    <li key={`${directory.role}-${directory.path ?? index}`}>
      <span className={`sh-agent-card__path sh-agent-card__path--${directory.status}`}>
        {content}
      </span>
    </li>
  );
}

function DeploymentCapabilityIcons({
  directory,
  t,
}: {
  directory?: AgentDirectoryView;
  t: (key: string, options?: Record<string, unknown>) => string;
}): JSX.Element | null {
  if (!directory) return null;
  const methods = [
    ["managed_copy", "⧉"],
    ["symbolic_link", "↗"],
    ["directory_junction", "⊞"],
  ] as const;
  return (
    <div aria-label={String(t("agents.deploymentMethods.label"))} className="sh-agent-card__deployment-methods">
      {methods.map(([mode, symbol]) => {
        const supported = directory.supportedModes.includes(mode);
        const recommended = directory.preferredMode === mode;
        return (
          <span
            aria-label={String(t(`agents.deploymentMethods.${mode}.${supported ? "supported" : "unsupported"}`))}
            className={`sh-agent-card__deployment-method ${supported ? "is-supported" : "is-unsupported"} ${recommended ? "is-recommended" : ""}`}
            key={mode}
            title={String(t(`agents.deploymentMethods.${mode}.${supported ? "supported" : "unsupported"}`))}
          >
            <span aria-hidden="true">{symbol}</span>
          </span>
        );
      })}
    </div>
  );
}
