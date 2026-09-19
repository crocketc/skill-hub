import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { desktopDirectoryPicker, type DirectoryPicker } from "../../platform/directoryPicker";
import { onDeploymentFactsChanged } from "../../platform/deploymentEvents";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { BrandTag } from "../../ui/BrandTag";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Drawer } from "../../ui/Drawer";
import { PageHeader } from "../../ui/PageHeader";
import { StatusBadge } from "../../ui/StatusBadge";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { type AgentFacade, type AgentView, unavailableAgentFacade } from "./api";
import { CustomAgentForm } from "./CustomAgentForm";
import "./agents.css";

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

  const agentGroups = useMemo(() => {
    const grouped = new Map<string, AgentView[]>();
    for (const agent of agents ?? []) {
      grouped.set(agent.brand, [...(grouped.get(agent.brand) ?? []), agent]);
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [agents]);

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
      {agents.length === 0 ? <DataState message={t("agents.empty")} state="empty" /> : agentGroups.map(([brand, groupedAgents]) => (
        <section aria-labelledby={`agent-brand-${brand}`} className="sh-agents-page__brand" key={brand}>
          <h2 id={`agent-brand-${brand}`}><BrandTag brand={brand} /></h2>
          <ul className="sh-agents-page__cards">
            {groupedAgents.map((agent) => (
              <li className="sh-agent-card" key={agent.id}>
                <div className="sh-agent-card__head">
                  <Link className="sh-agent-card__title" to={`/agents/${agent.id}`}>{agent.instance}</Link>
                  <StatusBadge tone={statusTone(agent.status)}>{t(`agents.status.${agent.status}`)}</StatusBadge>
                </div>
                <div className="sh-agent-card__paths">
                  <span className="sh-agent-card__paths-label">{t("agents.card.directory")}</span>
                  <ul className="sh-agent-card__path-list">
                    {agent.discoveredPaths.map((path) => <li key={path}><code className="sh-agent-card__path">{path}</code></li>)}
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
        </section>
      ))}
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

function statusTone(status: AgentView["status"]): "info" | "neutral" | "success" | "warning" {
  if (status === "accessible") return "success";
  if (status === "inaccessible") return "warning";
  if (status === "custom") return "info";
  return "neutral";
}
