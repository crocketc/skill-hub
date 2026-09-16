import { useSyncExternalStore } from "react";

/**
 * 统一执行生命周期（实现计划 任务 4）：
 * queued → running → success | partial | failed | cancelled | needs_user。
 * needs_user 之后可经 start() 回到 running（用户完成所需动作后继续）。
 */
export type TrackedOperationStatus =
  | "queued"
  | "running"
  | "needs_user"
  | "success"
  | "partial"
  | "failed"
  | "cancelled";

export interface TrackedOperation {
  id: string;
  kind: string;
  label: string;
  status: TrackedOperationStatus;
  completed: number;
  total: number;
  /** total > 0 时百分比可知；为 0 时界面必须诚实显示“未知”。 */
  hasKnownTotal: boolean;
  /**
   * 后端 operation repository 的持久化记录 id。顶栏、通知中心与
   * /operations/:id 操作记录三者经同一 id 关联；前端投影绝不是持久化来源。
   */
  operationId: string | null;
  /** 深链目标（默认 /operations/:operationId）；null 表示暂无可跳转目标。 */
  targetHref: string | null;
  /** 父任务 id（如 relation_governance_batch 父操作下的子任务）。 */
  parentId: string | null;
  /** 当前阶段（后端 message code 或已本地化文本）。 */
  phase: string | null;
  /** 用户可发起取消的能力位；实际取消仍由后端命令确认。 */
  canCancel: boolean;
  /** 用户已请求取消（等待后端确认期间 UI 不得重复发起）。 */
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  resultSummary: TrackedResultSummary | null;
}

export interface TrackedResultSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  todo?: number;
}

export interface BeginTrackedOperation {
  kind: string;
  label: string;
  /** 未知总数传 0：百分比未知是合法状态，不得伪造。 */
  total: number;
  operationId?: string;
  targetHref?: string;
  parentId?: string;
  phase?: string;
  canCancel?: boolean;
}

/** attach 允许的关联补丁：把前端在途项与持久化操作记录绑定。 */
export interface TrackedOperationPatch {
  operationId?: string;
  targetHref?: string;
  phase?: string;
  label?: string;
}

export interface OperationTracker {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TrackedOperation[];
  /** 登记一个在途操作，初始状态 queued；返回前端跟踪 id。 */
  begin: (input: BeginTrackedOperation) => string;
  /** queued/needs_user → running（needs_user 在用户完成动作后恢复）。 */
  start: (id: string) => void;
  progress: (id: string, completed: number, total?: number) => void;
  /** 关联持久化 operationId/targetHref/阶段；三端共用同一 operation id。 */
  attach: (id: string, patch: TrackedOperationPatch) => void;
  /** 执行被阻塞、需要用户显式处理（如恢复确认）时进入。 */
  needsUser: (id: string, phase?: string) => void;
  complete: (id: string, summary: TrackedResultSummary) => void;
  fail: (id: string, error: string) => void;
  cancel: (id: string) => void;
  /** 记录用户的取消请求；真实取消由后端命令结果经 cancel() 确认。 */
  requestCancel: (id: string) => void;
  /** Whether any still-in-flight operation has the given kind（导入互斥用）. */
  hasRunningKind: (kind: string) => boolean;
}

const MAX_HISTORY = 10;

const IN_FLIGHT_STATUSES: ReadonlySet<TrackedOperationStatus> = new Set([
  "queued",
  "running",
  "needs_user",
]);

/** 在途 = 未到达任何终态（queued/running/needs_user）；顶栏分页只看这些。 */
export function isInFlight(operation: TrackedOperation): boolean {
  return IN_FLIGHT_STATUSES.has(operation.status);
}

/** 顶栏/浮层分页的在途子集：保持 store 顺序（最新在前，即“当前项”最先）。 */
export function inFlightOperations(operations: readonly TrackedOperation[]): TrackedOperation[] {
  return operations.filter(isInFlight);
}

/** 批量汇总 → 终态：有成功有失败=partial，全失败=failed，否则 success。 */
function statusForSummary(summary: TrackedResultSummary): TrackedOperationStatus {
  if (summary.failed > 0) {
    return summary.succeeded > 0 ? "partial" : "failed";
  }
  return "success";
}

/**
 * 全局操作跟踪（验收反馈 #12 / FE-14 前置 / 任务 4 统一执行桥）：模块级单例
 * store，是前端的**在途规范化投影**——只服务顶栏、通知与操作记录页的会话内
 * 展示，绝不是持久化来源；审计事实仍只存在于后端 operation repository。
 * 组件卸载或路由切换不影响循环本身——async 循环持有 store 引用继续写进度。
 */
export function createOperationTracker(): OperationTracker {
  let operations: TrackedOperation[] = [];
  const listeners = new Set<() => void>();

  const emit = () => {
    operations = [...operations];
    for (const listener of listeners) {
      listener();
    }
  };

  const find = (id: string) => operations.find((operation) => operation.id === id);

  const mutate = (id: string, transform: (operation: TrackedOperation) => TrackedOperation) => {
    operations = operations.map((current) => (current.id === id ? transform(current) : current));
    emit();
  };

  const finish = (id: string, patch: Partial<TrackedOperation>) => {
    const operation = find(id);
    if (!operation || !isInFlight(operation)) return;
    mutate(id, (current) => ({
      ...current,
      ...patch,
      finishedAt: Date.now(),
    }));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return operations;
    },
    hasRunningKind(kind) {
      return operations.some(
        (operation) => isInFlight(operation) && operation.kind === kind,
      );
    },
    begin(input) {
      const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      operations = [
        {
          id,
          kind: input.kind,
          label: input.label,
          status: "queued",
          completed: 0,
          total: input.total,
          hasKnownTotal: input.total > 0,
          operationId: input.operationId ?? null,
          targetHref: input.targetHref
            ?? (input.operationId ? `/operations/${input.operationId}` : null),
          parentId: input.parentId ?? null,
          phase: input.phase ?? null,
          canCancel: input.canCancel ?? false,
          cancelRequested: false,
          startedAt: Date.now(),
          finishedAt: null,
          error: null,
          resultSummary: null,
        },
        ...operations.slice(0, MAX_HISTORY - 1),
      ];
      emit();
      return id;
    },
    start(id) {
      const operation = find(id);
      if (!operation) return;
      if (operation.status !== "queued" && operation.status !== "needs_user") return;
      mutate(id, (current) => ({ ...current, status: "running" }));
    },
    progress(id, completed, total) {
      const operation = find(id);
      if (!operation) return;
      if (operation.status === "queued") {
        // 进度到达即证明执行已开始：queued 诚实升为 running。
        mutate(id, (current) => ({
          ...current,
          status: "running",
          completed,
          total: total ?? current.total,
          hasKnownTotal: (total ?? current.total) > 0,
        }));
        return;
      }
      if (operation.status !== "running") return;
      mutate(id, (current) => ({
        ...current,
        completed,
        total: total ?? current.total,
        hasKnownTotal: (total ?? current.total) > 0,
      }));
    },
    attach(id, patch) {
      const operation = find(id);
      if (!operation) return;
      mutate(id, (current) => ({
        ...current,
        label: patch.label ?? current.label,
        phase: patch.phase ?? current.phase,
        operationId: patch.operationId ?? current.operationId,
        targetHref: patch.targetHref
          ?? (patch.operationId && !current.targetHref
            ? `/operations/${patch.operationId}`
            : current.targetHref),
      }));
    },
    needsUser(id, phase) {
      const operation = find(id);
      if (!operation || !isInFlight(operation)) return;
      mutate(id, (current) => ({
        ...current,
        status: "needs_user",
        phase: phase ?? current.phase,
      }));
    },
    complete(id, summary) {
      const operation = find(id);
      if (!operation || !isInFlight(operation)) return;
      finish(id, {
        status: statusForSummary(summary),
        completed: operation.total,
        resultSummary: summary,
      });
    },
    fail(id, error) {
      finish(id, { status: "failed", error });
    },
    cancel(id) {
      finish(id, { status: "cancelled" });
    },
    requestCancel(id) {
      const operation = find(id);
      if (!operation || !isInFlight(operation)) return;
      mutate(id, (current) => ({ ...current, cancelRequested: true }));
    },
  };
}

/** 应用级单例：跨路由存续，任何页面都能订阅。 */
export const operationTracker = createOperationTracker();

/** React 订阅入口；默认订阅应用级单例，测试可注入独立 store。 */
export function useTrackedOperations(source: OperationTracker = operationTracker): TrackedOperation[] {
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

/**
 * 是否存在进行中的指定类型操作（AR-014 导入互斥）。跟随 store 订阅更新，
 * 在途（含 queued/needs_user）状态结束后自动解除，无需手动清理。
 */
export function useHasRunningOperation(source: OperationTracker, kind: string): boolean {
  const operations = useTrackedOperations(source);
  return operations.some(
    (operation) => isInFlight(operation) && operation.kind === kind,
  );
}
