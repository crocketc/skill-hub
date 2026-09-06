import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type ReconcileAction,
  type ReconcilePlan,
  type ReconcileResult,
} from "../../api/bindings";

function planResult(result: AppQueryResult): ReconcilePlan {
  if (result.type !== "reconcile_plan") {
    throw new Error("reconcile.plan_unexpected_result");
  }
  return result.payload;
}

function actionResult(result: AppCommandResult): ReconcileResult {
  if (result.type !== "reconcile_result") {
    throw new Error("reconcile.process_unexpected_result");
  }
  return result.payload;
}

export const nativeReconcileFacade = {
  async getPlan(deploymentId: string): Promise<ReconcilePlan> {
    return planResult(await queryApplication({
      type: "get_reconcile_plan",
      payload: { deployment_id: deploymentId },
    }));
  },

  async apply(deploymentId: string, action: ReconcileAction): Promise<ReconcileResult> {
    const command = {
      collect_changes: "collect_deployment_changes",
      restore: "restore_deployment",
      keep_independent_copy: "keep_independent_copy",
      ignore: "ignore_external_change",
    }[action] as "collect_deployment_changes" | "restore_deployment" | "keep_independent_copy" | "ignore_external_change";
    return actionResult(await executeCommand({
      type: command,
      payload: { deployment_id: deploymentId },
    }));
  },
};
