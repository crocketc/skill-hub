export type OperationPhase = "planned" | "prepared" | "applying" | "verifying" | "committed" | "needs_recovery" | "rolled_back";
export type OperationState = { operationId: string; phase: OperationPhase; completed: number; total: number; message: string };
export interface OperationFacade { get(operationId: string): Promise<OperationState>; acknowledgeRecovery(operationId: string): Promise<void>; }
const unavailable = (operation: string): Promise<never> => Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
export const unavailableOperationFacade: OperationFacade = { get: () => unavailable("operation_get"), acknowledgeRecovery: () => unavailable("recovery_acknowledge") };
