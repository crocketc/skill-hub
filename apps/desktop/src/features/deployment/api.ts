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
  /** 后端持久化操作记录 id（任务 4）：顶栏/通知/操作记录三端同一 id。 */
  operationId?: string;
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
  /**
   * 预览失败必须保留结构化错误本体（DEV-18）：message 只是纯文本兜底，
   * 页面用 `describeNativeError(error)` 渲染可读文案，绝不 `String(对象)`。
   */
  failures: Array<{ skillId: string; displayName?: string; message: string; error?: NativeAppError }>;
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
  /** onProgress（可选）：每完成一个 Skill 回调一次，值=已完成的 Skill 数。 */
  commit(plans: BatchDeploymentPlan[], onProgress?: (completedSkills: number) => void): Promise<BatchDeploymentResult[]>;
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
