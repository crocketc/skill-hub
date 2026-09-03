import { executeCommand, queryApplication } from "../../api/bindings";
import type { OperationFacade, OperationState } from "./api";

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
  async acknowledgeRecovery(operationId) {
    const candidates = await queryApplication({ type: "list_recovery_candidates" });
    if (candidates.type !== "recovery_candidates" || !candidates.payload.some((candidate) => candidate.operation_id === operationId)) {
      throw new Error("recovery operation was not found");
    }
    const result = await executeCommand({ type: "acknowledge_recovery", payload: { operation_id: operationId } });
    if (result.type !== "operation_summary") throw new Error("recovery acknowledgement returned an unexpected result");
  },
};
