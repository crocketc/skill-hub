import { AgentPresentation } from "../../ui/AgentPresentation";
import type { DeploymentTarget } from "./api";

export function DeploymentTargetPresentation({
  target,
  fallback,
}: {
  target?: DeploymentTarget;
  fallback: string;
}) {
  if (target?.agentClientId) {
    return (
      <AgentPresentation
        agentId={target.agentClientId}
        brand={target.agentProfileId}
        sharedAgentBrands={target.sharedAgentBrands}
        sharedDirectory={target.sharedDirectory}
      />
    );
  }
  return <strong>{target?.label ?? fallback}</strong>;
}
