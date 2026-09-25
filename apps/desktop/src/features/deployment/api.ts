import type {
  TargetOperationError,
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

/** 该方式是否属于「链接部署」大类（符号链接或目录联接）。 */
export function isLinkMode(mode: DeploymentMode): boolean {
  return mode === "symbolic_link" || mode === "directory_junction";
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
    // 失败消息可能是稳定文案键（如 blocked 投影的 committedBlocked）：
    // 先按键翻译；未命中（自由文本）再按错误码/原文呈现，键名不裸奔。
    const keyed = translate(result.message, { defaultValue: "" });
    if (keyed) return keyed;
    return describeNativeError(result.message, translate, "deployment.errors.generic");
  }
  return translate(result.message, { defaultValue: result.message });
}

/**
 * 用户对「这个 Skill 怎么落到这个目标」的意图：自动（沿用每个目标的安全
 * 默认）、链接（必须链接，复制只能经用户确认作为回退）、复制（隔离副本）。
 * 具体实现方式（符号链接/目录联接/托管复制）由后端按事实决定，只进技术详情。
 */
export type DeploymentPreference = "automatic" | "link" | "copy";

/** 后端对一个 Skill × 目标 pair 的裁决（任务 13A 词表）。 */
export type DeploymentPreviewDisposition = "selected_mode" | "recommend_copy" | "no_change" | "blocked";

/** 结构化阻断原因：用户层五类文案，原始 code/path 只进技术详情（任务 14.4）。 */
export type DeploymentBlockReason =
  | "link_permission_unavailable"
  | "link_filesystem_unsupported"
  | "target_occupied"
  | "path_unavailable"
  | "shared_impact_requires_resolution";

/** 阻断原因 → 用户文案 i18n 键。原始错误码不进首屏。 */
export function deploymentBlockReasonKey(reason: DeploymentBlockReason): string {
  return `deployment.blockReason.${reason}`;
}

/** 提交后一个 pair 的终态（任务 14.9 词表）。 */
export type DeploymentPairOutcome = "deployed" | "no_change" | "excluded" | "blocked" | "failed";

/** pair 终态 → 既有三态结果投影：路由/汇总继续按 succeeded/failed/skipped 工作。 */
export function pairOutcomeStatus(outcome: DeploymentPairOutcome): DeploymentResult["status"] {
  switch (outcome) {
    case "deployed":
    case "no_change":
      return "succeeded";
    case "excluded":
      return "skipped";
    case "blocked":
    case "failed":
      return "failed";
  }
}

/** 一次预览中的一个 Skill × 物理目标 pair。 */
export type DeploymentPairPreview = {
  pairId: string;
  skillId: string;
  logicalTargetIds: string[];
  /** 后端解析的展示名；首屏文案用它，裸 SkillId 只进技术详情。 */
  skillDisplayName: string;
  runtimeName: string;
  targetLabel: string;
  targetPath: string;
  destinationPath: string;
  preference: DeploymentPreference;
  disposition: DeploymentPreviewDisposition;
  mode: DeploymentMode | null;
  fallbackMode: DeploymentMode | null;
  blockReason: DeploymentBlockReason | null;
  warnings: string[];
  /** 后端显式标明客户端持有的确认是否仍然有效（任务 14.7）。 */
  confirmationPreserved: boolean;
  confirmationFingerprint: string;
  /** 原始失败本体：只允许进「技术详情」折叠区。 */
  technicalError: TargetOperationError | null;
};

/** 服务端持有的一次批次预览：commit 只认 previewId，不认前端组装的计划。 */
export type DeploymentPreviewBatch = {
  previewId: string;
  expiresAt: string;
  pairs: DeploymentPairPreview[];
  /** 客户端持有的确认在本次重预览后仍然有效的 pair ids。 */
  preservedConfirmationIds: string[];
};

/** 一次预览请求条目：前端只表达意图，事实解析全部在后端。 */
export type BatchPreviewItem = {
  skillId: string;
  /** 缺省时由后端解析该 Skill 的当前库版本。 */
  versionId?: string;
  targetIds: string[];
  preference: DeploymentPreference;
};

/** 客户端在重预览时回传的确认：pair id → 用户确认时持有的指纹。 */
export type PreviewConfirmations = Record<string, string>;

/** 用户在分组里逐项取消的 pair：commit 与重预览都按 id 回传。 */
export type PairSelection = {
  pairId: string;
  confirmFallback: boolean;
  exclude: boolean;
};

export type BatchDeploymentResult = DeploymentResult & { skillId: string };

/**
 * 预览与提交都走服务端批次契约：一次 IPC 拿到全部 pair 事实；提交只回传
 * previewId 与用户选择，后端重验并生成最终计划（任务 13B/14.12/14.15）。
 */
export interface BatchDeploymentFacade {
  listTargets(): Promise<DeploymentTarget[]>;
  preview(
    items: BatchPreviewItem[],
    context?: { confirmations?: PreviewConfirmations; exclusions?: string[] },
  ): Promise<DeploymentPreviewBatch>;
  /** onProgress（可选）：每收到一批 pair 结果回调一次，值=已落定的可执行 pair 数。 */
  commit(
    preview: DeploymentPreviewBatch,
    selections: PairSelection[],
    onProgress?: (completed: number) => void,
  ): Promise<BatchDeploymentResult[]>;
  /** 项目关联 Agent（可选）：用于"项目目标展开为关联 Agent 目标"。 */
  listProjects?(): Promise<BatchProjectInfo[]>;
}

export type BatchProjectInfo = { id: string; agentIds: string[] };

/**
 * 分组键（任务 14.6）：处置 + 结构化原因 + 落地方式 + 回退方式。同一原因
 * 文案但不同影响（链接 vs 复制）的 pair 不会并成一组。
 */
export function dispositionGroupKey(pair: DeploymentPairPreview): string {
  return [pair.disposition, pair.blockReason ?? "", pair.mode ?? "", pair.fallbackMode ?? ""].join("|");
}

export type DispositionGroup = {
  key: string;
  disposition: DeploymentPreviewDisposition;
  blockReason: DeploymentBlockReason | null;
  mode: DeploymentMode | null;
  fallbackMode: DeploymentMode | null;
  pairs: DeploymentPairPreview[];
};

/** 按固定顺序（可执行 → 建议复制 → 无需变更 → 阻断）稳定分组。 */
export function groupPairsByDisposition(pairs: DeploymentPairPreview[]): DispositionGroup[] {
  const groups = new Map<string, DispositionGroup>();
  for (const pair of pairs) {
    const key = dispositionGroupKey(pair);
    const existing = groups.get(key);
    if (existing) {
      existing.pairs.push(pair);
    } else {
      groups.set(key, {
        key,
        disposition: pair.disposition,
        blockReason: pair.blockReason,
        mode: pair.mode,
        fallbackMode: pair.fallbackMode,
        pairs: [pair],
      });
    }
  }
  const order: Record<DeploymentPreviewDisposition, number> = {
    selected_mode: 0,
    recommend_copy: 1,
    no_change: 2,
    blocked: 3,
  };
  return [...groups.values()].sort((left, right) =>
    order[left.disposition] - order[right.disposition] || left.key.localeCompare(right.key));
}

const unavailable = (operation: string): Promise<never> =>
  Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));

export const unavailableDeploymentFacade: BatchDeploymentFacade = {
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
