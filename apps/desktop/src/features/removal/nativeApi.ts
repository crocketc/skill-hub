import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type RemovalDecision,
  type RemovalImpact,
  type RemovalResult,
} from "../../api/bindings";
import type { RemovalChoice } from "./api";

function impactResult(result: AppQueryResult | AppCommandResult): RemovalImpact {
  if (result.type !== "removal_impact") {
    throw new Error("解除部署影响查询返回了无法识别的结果");
  }
  return result.payload;
}

function removalResult(result: AppCommandResult): RemovalResult {
  if (result.type !== "removal_result") {
    throw new Error("解除部署提交返回了无法识别的结果");
  }
  return result.payload;
}

export const nativeRemovalFacade = {
  async getImpact(skillId: string): Promise<RemovalImpact> {
    return impactResult(await queryApplication({
      type: "get_removal_impact",
      payload: { skill_id: skillId },
    }));
  },

  async undeploy(deploymentId: string, decision: RemovalDecision): Promise<RemovalResult> {
    const prepared = impactResult(await executeCommand({
      type: "prepare_undeploy",
      payload: { deployment_id: deploymentId },
    }));
    return removalResult(await executeCommand({
      type: "commit_undeploy",
      payload: { prepared_undeploy_id: prepared.operation_id, decision },
    }));
  },

  async detachManagement(deploymentId: string): Promise<RemovalResult> {
    return removalResult(await executeCommand({
      type: "detach_management",
      payload: { deployment_id: deploymentId },
    }));
  },

  async deleteSkill(skillId: string, choices: Record<string, RemovalChoice>): Promise<RemovalResult> {
    const prepared = impactResult(await executeCommand({
      type: "prepare_delete_skill",
      payload: { skill_id: skillId },
    }));
    const decisions = Object.entries(choices).map(([deploymentId, choice]) => ({
      deployment_id: deploymentId,
      decision: deleteChoiceToDecision(choice),
    }));
    return removalResult(await executeCommand({
      type: "commit_delete_skill",
      payload: { prepared_delete_id: prepared.operation_id, decisions },
    }));
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
