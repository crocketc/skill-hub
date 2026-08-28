import type { OperationFacade, OperationState } from "../operations/api";
export type RecoveryFacade = OperationFacade;
export const recoveryFixture = (): OperationState => ({ operationId: "op-42", phase: "needs_recovery", completed: 2, total: 3, message: "有一个目标需要恢复" });
