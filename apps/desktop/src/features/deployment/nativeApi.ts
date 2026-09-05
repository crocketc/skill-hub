import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type DeploymentPlan as NativeDeploymentPlan,
  type DeploymentTarget as NativeDeploymentTarget,
} from "../../api/bindings";
import type {
  BatchDeploymentFacade,
  BatchDeploymentPlan,
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
};

function targetsResult(result: AppQueryResult): NativeDeploymentTarget[] {
  if (result.type !== "deployment_targets") {
    throw new Error("部署目标查询返回了无法识别的结果");
  }
  return result.payload;
}

function planResult(result: AppQueryResult): NativeDeploymentPlan {
  if (result.type !== "deployment_plan") {
    throw new Error("部署预览返回了无法识别的结果");
  }
  return result.payload;
}

function preparedResult(result: AppCommandResult) {
  if (result.type !== "prepared_deployment") {
    throw new Error("部署准备返回了无法识别的结果");
  }
  return result.payload;
}

function summaryResult(result: AppCommandResult) {
  if (result.type !== "deployment_summary") {
    throw new Error("部署提交返回了无法识别的结果");
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
  return status === "succeeded" ? "部署成功" : "部署失败";
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
      if (!runtimeName || versionId === "current") {
        const skill = await queryApplication({ type: "get_skill", payload: { skill_id: context.skillId } });
        if (skill.type !== "skill") throw new Error("无法读取 Skill 的运行时名称");
        runtimeName ??= skill.payload.runtime_name;
        if (versionId === "current") {
          if (!skill.payload.current_version) throw new Error("该 Skill 尚无可部署版本");
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
      return toPlan(planResult(result), selectedById);
    },

    async commit(plan) {
      const nativePlan = plan.native;
      if (!nativePlan) throw new Error("部署预览数据已失效，请重新预览");
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
      }));
    },
  };
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

type BatchPreviewAttempt =
  | { ok: true; skillId: string; plan: DeploymentPlan }
  | { ok: false; skillId: string; message: string };

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
          return { ok: false, skillId, message: messageOf(reason) };
        }
      }));
      const plans: BatchDeploymentPlan[] = [];
      const failures: Array<{ skillId: string; message: string }> = [];
      for (const preview of previews) {
        if (preview.ok) {
          plans.push({ skillId: preview.skillId, plan: preview.plan });
        } else {
          failures.push({ skillId: preview.skillId, message: preview.message });
        }
      }
      return { plans, failures };
    },

    async commit(plans: BatchDeploymentPlan[]): Promise<BatchDeploymentResult[]> {
      const results: BatchDeploymentResult[] = [];
      for (const { skillId, plan } of plans) {
        try {
          const committed = await createNativeDeploymentFacade({ skillId, versionId: plan.versionId }).commit(plan);
          results.push(...committed.map((result) => ({ ...result, skillId })));
        } catch (reason) {
          results.push(...plan.targets.map((target) => ({
            skillId,
            targetId: target.targetId,
            label: target.label,
            status: "failed" as const,
            message: messageOf(reason),
          })));
        }
      }
      return results;
    },
  };
}
