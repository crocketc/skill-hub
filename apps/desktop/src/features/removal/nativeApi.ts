import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type DeploymentTarget,
  type RemovalDecision,
  type RemovalImpact as NativeRemovalImpact,
  type RemovalResult as NativeRemovalResult,
} from "../../api/bindings";
import { indexTargetsByAnyId } from "../deployment/targetProjection";
import type {
  RemovalChoice,
  RemovalFacade,
  RemovalImpact as DesktopRemovalImpact,
  RemovalResult as DesktopRemovalResult,
  UndeployDecision,
  UndeployImpact,
} from "./api";

function impactResult(result: AppQueryResult | AppCommandResult): NativeRemovalImpact {
  if (result.type !== "removal_impact") {
    throw new Error("removal.undeploy_impact_unexpected_result");
  }
  return result.payload;
}

function removalResult(result: AppCommandResult): NativeRemovalResult {
  if (result.type !== "removal_result") {
    throw new Error("removal.undeploy_commit_unexpected_result");
  }
  return result.payload;
}

function deploymentTargetUnavailable() {
  return {
    code: "removal.deployment_target_unavailable",
    severity: "error",
    params: {},
    actions: [],
  } as const;
}

function canonicalDeploymentTargetPath(path: string): string {
  const trimmed = path.trim().replaceAll("\\", "/");
  const isWindowsPath = /^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith("//");
  const hasUncPrefix = trimmed.startsWith("//");
  const collapsed = hasUncPrefix
    ? `//${trimmed.slice(2).replace(/\/{2,}/g, "/")}`
    : trimmed.replace(/\/{2,}/g, "/");
  const withoutTrailingSeparators = collapsed.replace(/\/+$/g, "");
  return isWindowsPath ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

function hasAmbiguousDeploymentTargetIdentity(
  targets: readonly DeploymentTarget[],
  deploymentTargetIds: ReadonlySet<string>,
): boolean {
  const identitiesByKey = new Map<string, { physicalId: string; path: string }>();
  for (const target of targets) {
    for (const key of [target.id, target.physical_id]) {
      if (!deploymentTargetIds.has(key)) continue;
      const canonicalPath = canonicalDeploymentTargetPath(target.path);
      if (target.physical_identity_verified !== true || !target.physical_id.trim() || !canonicalPath) {
        return true;
      }
      const identity = { physicalId: target.physical_id.trim(), path: canonicalPath };
      const previous = identitiesByKey.get(key);
      if (previous && (previous.physicalId !== identity.physicalId || previous.path !== identity.path)) {
        return true;
      }
      identitiesByKey.set(key, identity);
    }
  }
  return false;
}

export const nativeRemovalFacade = {
  async getImpact(skillId: string): Promise<NativeRemovalImpact> {
    return impactResult(await queryApplication({
      type: "get_removal_impact",
      payload: { skill_id: skillId },
    }));
  },

  async undeploy(deploymentId: string, decision: RemovalDecision): Promise<NativeRemovalResult> {
    const prepared = impactResult(await executeCommand({
      type: "prepare_undeploy",
      payload: { deployment_id: deploymentId },
    }));
    return removalResult(await executeCommand({
      type: "commit_undeploy",
      payload: { prepared_undeploy_id: prepared.operation_id, decision },
    }));
  },

  async prepareUndeploy(deploymentId: string, label: string): Promise<UndeployImpact> {
    const impact = impactResult(await executeCommand({
      type: "prepare_undeploy",
      payload: { deployment_id: deploymentId },
    }));
    return {
      deploymentId,
      label,
      operationId: impact.operation_id,
      sharedTarget: impact.requires_shared_target_choice,
    };
  },

  async commitUndeploy(operationId: string, decision: UndeployDecision): Promise<void> {
    removalResult(await executeCommand({
      type: "commit_undeploy",
      payload: { prepared_undeploy_id: operationId, decision },
    }));
  },

  async detachManagement(deploymentId: string): Promise<NativeRemovalResult> {
    return removalResult(await executeCommand({
      type: "detach_management",
      payload: { deployment_id: deploymentId },
    }));
  },

  async deleteSkill(skillId: string, choices: Record<string, RemovalChoice>): Promise<DesktopRemovalResult> {
    const prepared = await this.prepareDelete(skillId);
    return this.commitDelete(prepared.operationId ?? "", choices);
  },

  async prepareDelete(skillId: string, skillName?: string): Promise<DesktopRemovalImpact> {
    const impact = impactResult(await executeCommand({
      type: "prepare_delete_skill",
      payload: { skill_id: skillId },
    }));
    let targets: Map<string, DeploymentTarget> = new Map();
    if (impact.deployments.length > 0) {
      let targetsResult: AppQueryResult;
      try {
        targetsResult = await queryApplication({ type: "list_deployment_targets", payload: null });
      } catch {
        throw deploymentTargetUnavailable();
      }
      if (targetsResult.type !== "deployment_targets") {
        throw deploymentTargetUnavailable();
      }
      const deploymentTargetIds = new Set(impact.deployments.map((deployment) => deployment.target_id));
      if (hasAmbiguousDeploymentTargetIdentity(targetsResult.payload, deploymentTargetIds)) {
        throw deploymentTargetUnavailable();
      }
      targets = indexTargetsByAnyId(targetsResult.payload);
    }
    const deployments = impact.deployments.map((deployment) => {
      const target = targets.get(deployment.target_id);
      if (!target || !target.path.trim() || !target.physical_id.trim() || target.physical_identity_verified !== true) {
        throw deploymentTargetUnavailable();
      }
      return {
        id: deployment.id,
        label: target.label || deployment.runtime_name,
        path: target.path,
        physicalId: target.physical_id,
        agentId: target.agent_client_id ?? undefined,
        brand: target.agent_profile_id ?? undefined,
        sharedDirectory: target.shared_directory,
      };
    });
    return {
      operationId: impact.operation_id,
      skillId: impact.skill_id,
      skillName: skillName ?? skillId,
      deployments,
      // QA-001：逐字段映射领域影响矩阵，不再把依赖冒充成关联项目。
      // 绑定因 serde(default) 将新字段标为可选；后端总是发送，
      // 此处按缺省空集归一以保持桌面契约稳定。
      dependentProjects: impact.project_configs ?? [],
      declaredDependencies: impact.dependencies ?? [],
      pinnedVersions: (impact.pinned_versions ?? []).map((pin) => ({
        projectId: pin.project_id,
        versionId: pin.version_id,
      })),
      combinations: impact.combinations ?? [],
      relatedSkills: impact.related_skills ?? [],
      unknownExternalReferences: impact.unknown_external_references ?? [],
      // W1-2：prepare_delete 返回随主体删除的未保存编辑草稿数量，
      // 旧载荷缺省按 0 归一（消费方仅在数量 > 0 时呈现草稿行与确认说明）。
      draftCount: impact.draft_count ?? 0,
    };
  },

  async commitDelete(operationId: string, choices: Record<string, RemovalChoice>): Promise<DesktopRemovalResult> {
    const decisions = Object.entries(choices).map(([deploymentId, choice]) => ({
      deployment_id: deploymentId,
      decision: deleteChoiceToDecision(choice),
    }));
    const result = removalResult(await executeCommand({
      type: "commit_delete_skill",
      payload: { prepared_delete_id: operationId, decisions },
    }));
    // K2：逐项执行状态与中央删除失败事实完整进入桌面契约，不再只留
    // central_skill_deleted 单字段。绑定注释——state/status 旧载荷缺省按
    // 已提交/已执行读取，此处归一，消费方拿稳定形状。
    return {
      centralSkillDeleted: result.central_skill_deleted,
      state: result.state ?? "committed",
      recoveryOperationId: result.recovery_operation_id ?? null,
      centralDeleteError: result.central_delete_error ?? null,
      items: result.decisions.map((decision) => ({
        deploymentId: decision.deployment_id,
        status: decision.status ?? "applied",
        errorCode: decision.error_code ?? null,
      })),
    };
  },
};

export const unavailableRemovalFacade: RemovalFacade = {
  prepareUndeploy: async () => {
    throw new Error("removal.undeploy_not_wired");
  },
  commitUndeploy: async () => {
    throw new Error("removal.undeploy_not_wired");
  },
  prepareDelete: async () => {
    throw new Error("removal.delete_not_wired");
  },
  commitDelete: async () => {
    throw new Error("removal.delete_not_wired");
  },
};

function deleteChoiceToDecision(choice: RemovalChoice): RemovalDecision {
  switch (choice) {
    case "keep_deployed":
      return "keep_shared_deployment";
    case "remove_deployment":
      return "remove_owned_target";
    case "convert_to_copy":
      return "remove_relation_only";
    default:
      throw new Error("removal.decision_unexpected_result");
  }
}
