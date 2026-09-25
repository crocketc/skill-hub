import type { RecoveryAction } from "../../api/bindings";

export type OperationPhase = "planned" | "prepared" | "applying" | "verifying" | "committed" | "needs_recovery" | "rolled_back";
export type OperationState = { operationId: string; phase: OperationPhase; completed: number; total: number; message: string };

/** 需要用户处置的未完成操作：启动恢复闸门的候选。 */
export type RecoveryCandidate = { operationId: string; actions: RecoveryAction[] };

export interface OperationFacade {
  get(operationId: string): Promise<OperationState>;
  /** 列出需要用户处置的未完成操作；全部处置完，闸门才会放行其余路由。 */
  listRecoveryCandidates(): Promise<RecoveryCandidate[]>;
  /**
   * 恢复一个未完成的操作：撤销它已经写下的改动并结算账目。
   * `action` 由候选自己声明，后端会拒绝候选未声明的动作。
   */
  resolveRecovery(operationId: string, action: RecoveryAction): Promise<void>;
}

/** 最近操作记录（来自 BootstrapSnapshot.recent_operations 的持久化事实）。 */
export type RecentOperationRow = {
  operation_id: string;
  kind: string;
  state: string;
  phase: OperationPhase;
  error_code: string | null;
  created_at: string;
  /**
   * DEV-94：快照已携带的目标级明细（当前仅部署类操作非空）。可选——旧
   * 测试桩与消费方可以不提供；渲染层按存在与否决定是否输出目标摘要。
   */
  targets?: ReadonlyArray<{
    physical_target_id: string;
    path: string | null;
    error_code: string | null;
  }>;
};

export interface RecentOperationsReader {
  listRecentOperations: () => Promise<RecentOperationRow[]>;
}

const unavailable = (operation: string): Promise<never> => Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
export const unavailableOperationFacade: OperationFacade = {
  get: () => unavailable("operation_get"),
  listRecoveryCandidates: () => unavailable("recovery_list"),
  resolveRecovery: () => unavailable("recovery_resolve"),
};
