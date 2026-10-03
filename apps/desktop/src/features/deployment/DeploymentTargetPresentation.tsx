import { AgentPresentation } from "../../ui/AgentPresentation";
import { AgentDirectoryRoleBadge } from "../../ui/AgentDirectoryRoleBadge";
import { displayPath } from "../../platform/displayPath";
import { useTranslation } from "react-i18next";
import type { AgentCardModel } from "../agents/agentCardModel";
import { directoryStatusLabel, directoryStatusSuggestion } from "../agents/agentCardModel";
import { DeploymentCapabilityIcons } from "../agents/DeploymentCapabilityIcons";
import type { DeploymentTarget } from "./api";

export function DeploymentTargetPresentation({
  target,
  fallback,
  model,
  sharedBrandOverflowInteractive = true,
}: {
  target?: DeploymentTarget;
  fallback: string;
  model?: AgentCardModel;
  sharedBrandOverflowInteractive?: boolean;
}) {
  const { t } = useTranslation();
  const directory = model?.directories[0];
  const statusMessage = target?.directoryStatus
    ? String(t(directoryStatusLabel(target.directoryStatus) as never))
    : String(t("agents.pathUnavailable"));
  const pathValue = target?.available
    ? displayPath(target.path)
    : target?.directoryStatus === "missing"
      ? String(t("agents.pathPending"))
      : statusMessage;
  const suggestion = target?.directoryStatus
    && target.directoryStatus !== "missing"
    && target.directoryStatus !== "existing"
    ? `${statusMessage}: ${String(t(directoryStatusSuggestion(target.directoryStatus) as never))}`
    : undefined;
  const note = model?.builtin
    ? String(t("agents.builtinHint"))
    : model?.deploymentStatus === "deployed"
      ? String(t("agents.cardDeploymentStatus.deployed"))
      : model?.deploymentStatus === "partially_deployed"
        ? String(t("agents.cardDeploymentStatus.partiallyDeployed"))
        : undefined;
  const identity = model ? (
    <AgentPresentation
      agentId={target?.agentClientId}
      brand={model.brand}
      deploymentStatus={model.deploymentStatus}
      kinds={model.kinds}
      sharedAgentBrands={model.sharedAgentBrands}
      sharedAgentBrandKinds={model.sharedAgentBrandKinds}
      sharedBrandOverflowInteractive={sharedBrandOverflowInteractive}
      sharedDirectory={model.sharedDirectory}
    />
  ) : target?.agentClientId ? (
      <AgentPresentation
        agentId={target.agentClientId}
        brand={target.agentProfileId}
        sharedAgentBrands={target.sharedAgentBrands}
        sharedAgentBrandKinds={target.sharedAgentBrandKinds}
        sharedBrandOverflowInteractive={sharedBrandOverflowInteractive}
        sharedDirectory={target.sharedDirectory}
      />
  ) : <strong>{target?.label ?? fallback}</strong>;
  if (!model && !target?.agentClientId) {
    return (
      <>
        <strong>{target?.label ?? fallback}</strong>
        <small title={target ? displayPath(target.path) : fallback}>{pathValue}</small>
        {suggestion ? <small>{suggestion}</small> : null}
      </>
    );
  }
  return (
    <div className="sh-deployment-target-card__contents">
      <div className="sh-deployment-target-card__identity">{identity}</div>
      <div className="sh-deployment-target-card__role">
        <AgentDirectoryRoleBadge role={directory?.role ?? "agent_user"} />
      </div>
      <div className="sh-deployment-target-card__path-label">
        {t("agents.pathLabel")}
        {model?.supportsSharedDirectory && !model.sharedDirectory ? (
          <span className="sh-agent-card__shared-chip">{t("agents.sharedDirectoryChip")}</span>
        ) : null}
      </div>
      <div className="sh-deployment-target-card__path-region">
        <small title={target ? displayPath(target.path) : fallback}>{pathValue}</small>
        {suggestion ? <small className="sh-deployment-target-card__guidance">{suggestion}</small> : null}
      </div>
      <DeploymentCapabilityIcons directory={directory} note={note} t={(key) => String(t(key as never))} />
    </div>
  );
}
