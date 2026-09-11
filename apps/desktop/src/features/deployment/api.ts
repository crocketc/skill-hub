import type { DeploymentPlan as NativeDeploymentPlan } from "../../api/bindings";
import { describeNativeError, type NativeAppError } from "../../api/nativeErrors";

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
  skillId?: string;
  targetId: string;
  label: string;
  status: "succeeded" | "failed" | "skipped";
  message: string;
  error?: NativeAppError;
};

export type DeploymentTranslator = (key: string, options?: Record<string, unknown>) => string;

/** Render target-level native failures without exposing raw objects or keys. */
export function describeDeploymentResult(
  result: DeploymentResult,
  translate: DeploymentTranslator,
): string {
  if (result.error) {
    return describeNativeError(result.error, translate, "deployment.errors.generic");
  }
  if (result.status === "failed") {
    return describeNativeError(result.message, translate, "deployment.errors.generic");
  }
  return translate(result.message, { defaultValue: result.message });
}
export interface DeploymentFacade {
  listTargets(): Promise<DeploymentTarget[]>;
  preview(targets: DeploymentTarget[], mode?: DeploymentMode): Promise<DeploymentPlan>;
  commit(plan: DeploymentPlan): Promise<DeploymentResult[]>;
}

export type BatchDeploymentPlan = { skillId: string; plan: DeploymentPlan };
export type BatchDeploymentPreview = {
  plans: BatchDeploymentPlan[];
  failures: Array<{ skillId: string; message: string }>;
};
export type BatchDeploymentResult = DeploymentResult & { skillId: string };

/**
 * A batch is deliberately composed of per-Skill plans. The native contract
 * only prepares one Skill at a time, so this shape keeps every preview and
 * commit result visible instead of pretending the batch is atomic.
 */
export type BatchProjectInfo = { id: string; agentIds: string[] };

export interface BatchDeploymentFacade {
  listTargets(): Promise<DeploymentTarget[]>;
  preview(skillIds: string[], targets: DeploymentTarget[], mode?: DeploymentMode): Promise<BatchDeploymentPreview>;
  commit(plans: BatchDeploymentPlan[]): Promise<BatchDeploymentResult[]>;
  /** 项目关联 Agent（可选）：用于"项目目标展开为关联 Agent 目标"。 */
  listProjects?(): Promise<BatchProjectInfo[]>;
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
