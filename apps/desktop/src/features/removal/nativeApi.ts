import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type RemovalDecision,
  type RemovalImpact as NativeRemovalImpact,
  type RemovalResult as NativeRemovalResult,
} from "../../api/bindings";
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
    throw new Error("解除部署影响查询返回了无法识别的结果");
  }
  return result.payload;
}

function removalResult(result: AppCommandResult): NativeRemovalResult {
  if (result.type !== "removal_result") {
    throw new Error("解除部署提交返回了无法识别的结果");
  }
  return result.payload;
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
    return {
      operationId: impact.operation_id,
      skillId: impact.skill_id,
      skillName: skillName ?? skillId,
      deployments: impact.deployments.map((deployment) => ({
        id: deployment.id,
        label: deployment.runtime_name,
        path: deployment.target_id,
        physicalId: deployment.target_id,
      })),
      dependentProjects: impact.dependencies,
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
    return { centralSkillDeleted: result.central_skill_deleted };
  },
};

export const unavailableRemovalFacade: RemovalFacade = {
  prepareUndeploy: async () => {
    throw new Error("解除部署功能尚未接入");
  },
  commitUndeploy: async () => {
    throw new Error("解除部署功能尚未接入");
  },
  prepareDelete: async () => {
    throw new Error("删除功能尚未接入");
  },
  commitDelete: async () => {
    throw new Error("删除功能尚未接入");
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
      throw new Error("删除处理方式无法识别");
  }
}
