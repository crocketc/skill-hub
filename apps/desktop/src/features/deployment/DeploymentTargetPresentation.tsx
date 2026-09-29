import { AgentPresentation } from "../../ui/AgentPresentation";
import type { AgentCardModel } from "../agents/agentCardModel";
import type { DeploymentTarget } from "./api";

export function DeploymentTargetPresentation({
  target,
  fallback,
  model,
}: {
  target?: DeploymentTarget;
  fallback: string;
  model?: AgentCardModel;
}) {
  if (model) {
    return (
      <AgentPresentation
        agentId={target?.agentClientId}
        brand={model.brand}
        kinds={model.kinds}
        sharedAgentBrands={model.sharedAgentBrands}
        sharedAgentBrandKinds={model.sharedAgentBrandKinds}
        sharedDirectory={model.sharedDirectory}
      />
    );
  }
  if (target?.agentClientId) {
    return (
      <AgentPresentation
        agentId={target.agentClientId}
        brand={target.agentProfileId}
        sharedAgentBrands={target.sharedAgentBrands}
        sharedAgentBrandKinds={target.sharedAgentBrandKinds}
        sharedDirectory={target.sharedDirectory}
      />
    );
  }
  return <strong>{target?.label ?? fallback}</strong>;
}
