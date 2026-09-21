import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type DeploymentPlan as NativeDeploymentPlan,
  type DeploymentTarget as NativeDeploymentTarget,
} from "../../api/bindings";
import { isStructuredNativeError, type NativeAppError } from "../../api/nativeErrors";
import type {
  BatchDeploymentFacade,
  BatchDeploymentPlan,
  BatchDeploymentPreview,
  BatchDeploymentResult,
  DeploymentFacade,
  DeploymentMode,
  DeploymentPlan,
  DeploymentPlanTarget,
  DeploymentResult,
  DeploymentTarget,
} from "./api";

type NativeDeploymentContext = {
  skillId: string;
  versionId: string;
  runtimeName?: string;
  /** 已知展示名时不再回源查询（DEV-18-A）。 */
  displayName?: string;
};

function targetsResult(result: AppQueryResult): NativeDeploymentTarget[] {
  if (result.type !== "deployment_targets") {
    throw new Error("deployment.targets_unexpected_result");
  }
  return result.payload;
}

function planResult(result: AppQueryResult): NativeDeploymentPlan {
  if (result.type !== "deployment_plan") {
    throw new Error("deployment.plan_unexpected_result");
  }
  return result.payload;
}

function preparedResult(result: AppCommandResult) {
  if (result.type !== "prepared_deployment") {
    throw new Error("deployment.prepare_unexpected_result");
  }
  return result.payload;
}

function summaryResult(result: AppCommandResult) {
  if (result.type !== "deployment_summary") {
    throw new Error("deployment.commit_unexpected_result");
  }
  return result.payload;
}

function toTarget(target: NativeDeploymentTarget): DeploymentTarget {
  return {
    id: target.id,
    label: target.label,
    path: target.path,
    available: target.available,
    physicalId: target.physical_id,
    modes: target.modes,
  };
}

function labelForTarget(
  logicalIds: string[],
  selected: Map<string, DeploymentTarget | string>,
  physicalId: string,
): string {
  const label = logicalIds.map((id) => {
    const value = selected.get(id);
    return typeof value === "string" ? value : value?.label;
  }).filter(Boolean).join("、");
  return label || physicalId;
}

function toPlan(
  native: NativeDeploymentPlan,
  selected: Map<string, DeploymentTarget>,
): DeploymentPlan {
  const targets: DeploymentPlanTarget[] = native.targets.map((target) => ({
    targetId: target.logical_target_ids[0] ?? target.physical_target_id,
    label: labelForTarget(target.logical_target_ids, selected, target.physical_target_id),
    mode: target.mode,
    warnings: target.warnings,
  }));
  return {
    skillId: native.skill_id,
    versionId: native.version_id,
    targets,
    warnings: native.warnings,
    native,
  };
}

function toNativeMode(mode: DeploymentMode | undefined): DeploymentMode | null {
  return mode ?? null;
}

function resultMessage(errorCode: string | null, status: "succeeded" | "failed"): string {
  if (errorCode) return errorCode;
  // i18n 键而非句子：页面负责翻译。
  return status === "succeeded"
    ? "deployment.results.status.message.succeeded"
    : "deployment.results.status.message.failed";
}

export function createNativeDeploymentFacade(context: NativeDeploymentContext): DeploymentFacade {
  return {
    async listTargets() {
      const result = await queryApplication({ type: "list_deployment_targets", payload: null });
      return targetsResult(result).map(toTarget);
    },

    async preview(selected, mode) {
      const selectedById = new Map(selected.map((target) => [target.id, target]));
      let runtimeName = context.runtimeName;
      let versionId = context.versionId;
      let displayName = context.displayName;
      if (!runtimeName || versionId === "current") {
        const skill = await queryApplication({ type: "get_skill", payload: { skill_id: context.skillId } });
        if (skill.type !== "skill") throw new Error("deployment.runtime_name_unavailable");
        runtimeName ??= skill.payload.runtime_name;
        // 展示名回退 runtime name：供结果/计划主文案使用（DEV-18-A）。
        displayName ??= skill.payload.display_name || skill.payload.runtime_name;
        if (versionId === "current") {
          if (!skill.payload.current_version) throw new Error("deployment.no_current_version");
          versionId = skill.payload.current_version;
        }
      }
      const result = await queryApplication({
        type: "get_deployment_plan",
        payload: {
          request: {
            skill_id: context.skillId,
            version_id: versionId,
            runtime_name: runtimeName,
            logical_target_ids: selected.map((target) => target.id),
            mode_override: toNativeMode(mode),
          },
        },
      });
      return { ...toPlan(planResult(result), selectedById), displayName };
    },

    async commit(plan) {
      const nativePlan = plan.native;
      if (!nativePlan) throw new Error("deployment.plan_stale");
      const prepared = preparedResult(await executeCommand({
        type: "prepare_deployment",
        payload: { plan: nativePlan },
      }));
      const summary = summaryResult(await executeCommand({
        type: "commit_deployment",
        payload: { prepared_deployment_id: prepared.id },
      }));
      const labels = new Map(plan.targets.map((target) => [target.targetId, target.label]));
      return summary.targets.map((target): DeploymentResult => ({
        targetId: target.logical_target_ids[0] ?? target.physical_target_id,
        label: labelForTarget(target.logical_target_ids, labels, target.physical_target_id),
        status: target.status,
        message: resultMessage(target.error_code, target.status),
        error: target.error ?? undefined,
        // 持久化操作记录 id：桌面端经同一 id 深链 /operations/:id（任务 4）。
        operationId: summary.operation_id,
      }));
    },
  };
}

/**
 * DEV-18：IPC 结构化 AppError 绝不能走 `String(reason)`（会渲染成
 * "[object Object]"，掩盖真实的占用冲突等原因）。此处把结构化错误本体
 * 摘出来随结果透传，页面用 `describeNativeError` 渲染可读文案；
 * 非 Error/非结构化的失败才退回纯文本。
 */
function structuredErrorOf(reason: unknown): NativeAppError | undefined {
  if (typeof reason === "object" && reason !== null && !(reason instanceof Error)) {
    if (isStructuredNativeError(reason)) return reason as NativeAppError;
  }
  if (typeof reason === "string" && isStructuredNativeError(reason)) {
    try {
      return JSON.parse(reason) as NativeAppError;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 预览/提交失败的三元组：message 取稳定错误码兜底，结构化错误本体随行透传。 */
function failureOf(reason: unknown): { message: string; error?: NativeAppError } {
  const error = structuredErrorOf(reason);
  if (error) return { message: error.code, error };
  return { message: reason instanceof Error ? reason.message : String(reason) };
}

type BatchPreviewAttempt =
  | { ok: true; skillId: string; plan: DeploymentPlan }
  | { ok: false; skillId: string; displayName?: string; message: string; error?: NativeAppError };

/**
 * The native boundary prepares and commits exactly one Skill per operation.
 * Compose those operations here so the UI can offer one consistent batch flow
 * while preserving a result for every Skill and target.
 */
async function listProjects() {
  const result = await queryApplication({ type: "list_projects", payload: null });
  if (result.type !== "projects") throw new Error("list_projects returned an unexpected result.");
  return result.payload.map((project) => ({ id: project.id, agentIds: project.agent_ids ?? [] }));
}

/** 解析 Skill 展示名（回退 runtime name），用于失败行主文案（DEV-18-A）。 */
async function resolveSkillDisplayName(skillId: string): Promise<string | undefined> {
  try {
    const result = await queryApplication({ type: "get_skill", payload: { skill_id: skillId } });
    if (result.type !== "skill") return undefined;
    return result.payload.display_name || result.payload.runtime_name || undefined;
  } catch {
    return undefined;
  }
}

export function createNativeBatchDeploymentFacade(): BatchDeploymentFacade {
  return {
    listTargets: () => createNativeDeploymentFacade({ skillId: "", versionId: "current" }).listTargets(),
    listProjects: () => listProjects(),

    async preview(skillIds, targets, mode) {
      const previews: BatchPreviewAttempt[] = await Promise.all(skillIds.map(async (skillId) => {
        try {
          const plan = await createNativeDeploymentFacade({ skillId, versionId: "current" }).preview(targets, mode);
          return { ok: true, skillId, plan };
        } catch (reason) {
          const failure = failureOf(reason);
          // 裸 Skill UUID 仅作兜底；优先带展示名（DEV-18-A）。
          const displayName = await resolveSkillDisplayName(skillId);
          return { ok: false, skillId, displayName, ...failure };
        }
      }));
      const plans: BatchDeploymentPlan[] = [];
      const failures: BatchDeploymentPreview["failures"] = [];
      for (const preview of previews) {
        if (preview.ok) {
          plans.push({ skillId: preview.skillId, displayName: preview.plan.displayName, plan: preview.plan });
        } else {
          failures.push({ skillId: preview.skillId, displayName: preview.displayName, message: preview.message, error: preview.error });
        }
      }
      return { plans, failures };
    },

    async commit(plans: BatchDeploymentPlan[], onProgress?: (completedSkills: number) => void): Promise<BatchDeploymentResult[]> {
      const results: BatchDeploymentResult[] = [];
      for (const { skillId, displayName, plan } of plans) {
        // 展示名随结果投影：结果行主文案用展示名，裸 UUID 只进技术详情（DEV-18-A）。
        const resolvedName = displayName ?? plan.displayName ?? await resolveSkillDisplayName(skillId);
        try {
          const committed = await createNativeDeploymentFacade({ skillId, versionId: plan.versionId }).commit(plan);
          results.push(...committed.map((result) => ({ ...result, skillId, displayName: resolvedName })));
        } catch (reason) {
          const failure = failureOf(reason);
          results.push(...plan.targets.map((target) => ({
            skillId,
            displayName: resolvedName,
            targetId: target.targetId,
            label: target.label,
            status: "failed" as const,
            message: failure.message,
            error: failure.error,
          })));
        }
        // 批次非原子：每个 Skill 落定即推进一次真实进度（不做估算）。
        onProgress?.(results.length ? new Set(results.map((result) => result.skillId)).size : 0);
      }
      return results;
    },
  };
}
