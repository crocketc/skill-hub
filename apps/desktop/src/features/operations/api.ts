export type OperationPhase = "planned" | "prepared" | "applying" | "verifying" | "committed" | "needs_recovery" | "rolled_back";
export type OperationState = { operationId: string; phase: OperationPhase; completed: number; total: number; message: string };
export interface OperationFacade { get(operationId: string): Promise<OperationState>; acknowledgeRecovery(operationId: string): Promise<void>; }

/** 最近操作记录（来自 BootstrapSnapshot.recent_operations 的持久化事实）。 */
export type RecentOperationRow = {
  operation_id: string;
  kind: string;
  state: string;
  phase: OperationPhase;
  error_code: string | null;
  created_at: string;
};

export interface RecentOperationsReader {
  listRecentOperations: () => Promise<RecentOperationRow[]>;
}

const unavailable = (operation: string): Promise<never> => Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
export const unavailableOperationFacade: OperationFacade = { get: () => unavailable("operation_get"), acknowledgeRecovery: () => unavailable("recovery_acknowledge") };
