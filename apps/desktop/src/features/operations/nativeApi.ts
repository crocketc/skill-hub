import { executeCommand, queryApplication } from "../../api/bindings";
import type { OperationFacade, OperationState, RecentOperationRow, RecentOperationsReader } from "./api";

export type { RecentOperationsReader, RecentOperationRow };

export const nativeRecentOperations: RecentOperationsReader = {
  async listRecentOperations() {
    const result = await queryApplication({ type: "get_bootstrap_snapshot" });
    if (result.type !== "bootstrap_snapshot") throw new Error("operation query returned an unexpected result");
    return result.payload.recent_operations;
  },
};

export const nativeOperationFacade: OperationFacade = {
  async get(operationId) {
    const result = await queryApplication({ type: "get_bootstrap_snapshot" });
    if (result.type !== "bootstrap_snapshot") throw new Error("operation query returned an unexpected result");
    const item = result.payload.recent_operations.find((operation) => operation.operation_id === operationId)
      ?? (operationId === "latest" ? result.payload.recent_operations[0] : undefined);
    if (!item) throw new Error("operation was not found");
    const state: OperationState = {
      operationId: item.operation_id,
      phase: item.phase,
      completed: item.phase === "committed" || item.phase === "rolled_back" ? 1 : 0,
      total: 1,
      message: item.error_code ?? item.kind,
    };
    return state;
  },
  /**
   * 恢复走 `resolve_recovery`，不再走 `acknowledge_recovery`：后者在应用层
   * 根本没有实现分支，调用只会拿到 `internal.error`，恢复页因此永远无法解闸。
   */
  async listRecoveryCandidates() {
    const result = await queryApplication({ type: "list_recovery_candidates" });
    if (result.type !== "recovery_candidates") throw new Error("recovery query returned an unexpected result");
    return result.payload.map((candidate) => ({ operationId: candidate.operation_id, actions: candidate.actions }));
  },
  async resolveRecovery(operationId, action) {
    const candidates = await queryApplication({ type: "list_recovery_candidates" });
    if (candidates.type !== "recovery_candidates" || !candidates.payload.some((candidate) => candidate.operation_id === operationId && candidate.actions.includes(action))) {
      throw new Error("recovery operation was not found");
    }
    const result = await executeCommand({ type: "resolve_recovery", payload: { operation_id: operationId, action } });
    if (result.type !== "operation_summary") throw new Error("recovery resolution returned an unexpected result");
  },
};
