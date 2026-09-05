import { useSyncExternalStore } from "react";

export type TrackedOperationStatus = "running" | "completed" | "failed" | "cancelled";

export interface TrackedOperation {
  id: string;
  kind: string;
  label: string;
  status: TrackedOperationStatus;
  completed: number;
  total: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  resultSummary: TrackedResultSummary | null;
}

export interface TrackedResultSummary {
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface BeginTrackedOperation {
  kind: string;
  label: string;
  total: number;
}

export interface OperationTracker {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TrackedOperation[];
  /** Starts a tracked operation and returns its id. */
  begin: (input: BeginTrackedOperation) => string;
  progress: (id: string, completed: number, total?: number) => void;
  complete: (id: string, summary: TrackedResultSummary) => void;
  fail: (id: string, error: string) => void;
  cancel: (id: string) => void;
}

const MAX_HISTORY = 10;

/**
 * 全局操作跟踪（验收反馈 #12 / FE-14 前置）：模块级单例 store，
 * 记录长时 UI 操作（当前为导入提交）的类型/进度/结果。组件卸载或路由
 * 切换不影响循环本身——async 循环持有 store 引用继续写进度，前端任何
 * 挂载的订阅者（全局指示器）都会通过 useSyncExternalStore 看到更新。
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
    begin(input) {
      const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      operations = [
        {
          id,
          kind: input.kind,
          label: input.label,
          status: "running",
          completed: 0,
          total: input.total,
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
    progress(id, completed, total) {
      const operation = find(id);
      if (!operation || operation.status !== "running") return;
      operations = operations.map((current) =>
        current.id === id
          ? {
              ...current,
              completed,
              total: total ?? current.total,
            }
          : current,
      );
      emit();
    },
    complete(id, summary) {
      const operation = find(id);
      if (!operation || operation.status !== "running") return;
      operations = operations.map((current) =>
        current.id === id
          ? {
              ...current,
              status: "completed",
              completed: current.total,
              finishedAt: Date.now(),
              resultSummary: summary,
            }
          : current,
      );
      emit();
    },
    fail(id, error) {
      const operation = find(id);
      if (!operation || operation.status !== "running") return;
      operations = operations.map((current) =>
        current.id === id
          ? { ...current, status: "failed", error, finishedAt: Date.now() }
          : current,
      );
      emit();
    },
    cancel(id) {
      const operation = find(id);
      if (!operation || operation.status !== "running") return;
      operations = operations.map((current) =>
        current.id === id ? { ...current, status: "cancelled", finishedAt: Date.now() } : current,
      );
      emit();
    },
  };
}

/** 应用级单例：跨路由存续，任何页面都能订阅。 */
export const operationTracker = createOperationTracker();

/** React 订阅入口；默认订阅应用级单例，测试可注入独立 store。 */
export function useTrackedOperations(source: OperationTracker = operationTracker): TrackedOperation[] {
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
