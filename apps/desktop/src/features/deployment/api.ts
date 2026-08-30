import type { DeploymentPlan as NativeDeploymentPlan } from "../../api/bindings";

export type DeploymentMode = "symbolic_link" | "directory_junction" | "managed_copy";
export type DeploymentTarget = {
  id: string;
  label: string;
  path: string;
  available: boolean;
  physicalId: string;
  modes: DeploymentMode[];
};
export type DeploymentPlanTarget = {
  targetId: string;
  label: string;
  mode: DeploymentMode;
  warnings: string[];
};
export type DeploymentPlan = {
  skillId: string;
  versionId: string;
  targets: DeploymentPlanTarget[];
  warnings: string[];
  native?: NativeDeploymentPlan;
};
export type DeploymentResult = {
  targetId: string;
  label: string;
  status: "succeeded" | "failed" | "skipped";
  message: string;
};
export interface DeploymentFacade {
  listTargets(): Promise<DeploymentTarget[]>;
  preview(targets: DeploymentTarget[], mode?: DeploymentMode): Promise<DeploymentPlan>;
  commit(plan: DeploymentPlan): Promise<DeploymentResult[]>;
}

const unavailable = (operation: string): Promise<never> =>
  Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));

export const unavailableDeploymentFacade: DeploymentFacade = {
  listTargets: () => unavailable("deployment_targets"),
  preview: () => unavailable("deployment_preview"),
  commit: () => unavailable("deployment_commit"),
};

export function deploymentTargetsFixture(): DeploymentTarget[] {
  return [
    {
      id: "codex-cli",
      label: "Codex CLI",
      path: "C:/Users/demo/.codex/skills",
      available: true,
      physicalId: "codex-skills",
      modes: ["symbolic_link", "managed_copy"],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      path: "C:/Users/demo/.claude/skills",
      available: true,
      physicalId: "claude-skills",
      modes: ["symbolic_link", "managed_copy"],
    },
    {
      id: "readonly-agent",
      label: "Read-only Agent",
      path: "C:/Agents/readonly",
      available: false,
      physicalId: "readonly",
      modes: ["managed_copy"],
    },
  ];
}
