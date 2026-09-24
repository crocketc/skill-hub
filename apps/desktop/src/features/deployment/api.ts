import type {
  DeploymentPlan as NativeDeploymentPlan,
  TargetChange,
  TargetConflict,
} from "../../api/bindings";
import { describeNativeError, type NativeAppError } from "../../api/nativeErrors";

export type DeploymentMode = "symbolic_link" | "directory_junction" | "managed_copy";

/**
 * 用户面向的部署方式标签：符号链接与目录联接都归并为「链接部署」，
 * 托管复制为「复制部署」。具体实现方式（符号链接/目录联接/托管复制）
 * 只进技术详情，不在首屏作为主文案出现（DEV-21-A）。
 */
export function userFacingDeploymentMode(mode: DeploymentMode): "deployment.mode.userCopy" | "deployment.mode.userLink" {
  return mode === "managed_copy" ? "deployment.mode.userCopy" : "deployment.mode.userLink";
}

/**
 * 目标告警同样可能携带实现方式术语（"不支持符号链接"/"不支持目录联接"）。
 * 用户层统一说「链接部署」/「复制部署」，原始键只留在技术详情（DEV-21-A）。
 */
const IMPLEMENTATION_WARNING_ALIASES: Record<string, string> = {
  "deployment.mode.symbolic_link_unavailable": "deployment.mode.userLinkUnavailable",
  "deployment.mode.directory_junction_unavailable": "deployment.mode.userLinkUnavailable",
};

const IMPLEMENTATION_MODE_WARNINGS = new Set([
  "deployment.mode.symbolic_link",
  "deployment.mode.directory_junction",
  "deployment.mode.managed_copy",
]);

/** 把实现方式告警改写为用户层文案；非实现方式告警原样返回。 */
export function userFacingDeploymentWarning(warning: string): string {
  return IMPLEMENTATION_WARNING_ALIASES[warning] ?? warning;
}

/** 该告警是否在描述实现方式（原始术语需要沉到技术详情）。 */
export function isImplementationWarning(warning: string): boolean {
  return Object.hasOwn(IMPLEMENTATION_WARNING_ALIASES, warning) || IMPLEMENTATION_MODE_WARNINGS.has(warning);
}

/** 模式说明是技术事实，不在卡片的用户提示区重复展示。 */
export function isModeDescriptionWarning(warning: string): boolean {
  return IMPLEMENTATION_MODE_WARNINGS.has(warning);
}

/** Skill 级 warnings 可能聚合了目标级 warnings；避免同一提示出现两次。 */
export function warningsNotCoveredByTargets(plan: DeploymentPlan): string[] {
  const targetWarnings = new Set(plan.targets.flatMap((target) => target.warnings));
  return plan.warnings.filter((warning) => !targetWarnings.has(warning));
}
export type DeploymentTarget = {
  id: string;
  label: string;
  path: string;
  available: boolean;
  physicalId: string;
  modes: DeploymentMode[];
  agentClientId?: string;
  agentProfileId?: string;
  sharedDirectory?: boolean;
  sharedAgentBrands?: string[];
};
export type DeploymentPlanTarget = {
  targetId: string;
  label: string;
  mode: DeploymentMode;
  warnings: string[];
  logicalTargetIds?: string[];
  targetPath?: string;
  destinationPath?: string;
  sourcePath?: string;
  change?: TargetChange;
  conflicts?: TargetConflict[];
};
export type DeploymentPlan = {
  skillId: string;
  versionId: string;
  /** 展示名（回退 runtime name）：预览阶段随计划解析，供主文案使用（DEV-18-A）。 */
  displayName?: string;
  targets: DeploymentPlanTarget[];
  warnings: string[];
  native?: NativeDeploymentPlan;
};
export type DeploymentResult = {
  skillId?: string;
  /** 展示名（回退 runtime name）：主文案用它，裸 UUID 只进技术详情（DEV-18-A）。 */
  displayName?: string;
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

export type BatchDeploymentPlan = { skillId: string; displayName?: string; plan: DeploymentPlan };
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
