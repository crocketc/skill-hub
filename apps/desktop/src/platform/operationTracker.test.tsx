import { act, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import { createOperationTracker, inFlightOperations } from "./operationTracker";

function useSnapshot(tracker: ReturnType<typeof createOperationTracker>) {
  return useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
}

function Probe({ tracker }: { tracker: ReturnType<typeof createOperationTracker> }) {
  const operations = useSnapshot(tracker);
  return (
    <ul>
      {operations.map((operation) => (
        <li key={operation.id}>
          {operation.label}:{operation.status}:{operation.completed}/{operation.total}
        </li>
      ))}
    </ul>
  );
}

describe("operationTracker", () => {
  it("tracks a full lifecycle from begin to complete", () => {
    const tracker = createOperationTracker();

    const id = tracker.begin({ kind: "import", label: "导入 2 个 Skill", total: 2 });
    tracker.progress(id, 1, 2);
    tracker.complete(id, { succeeded: 2, failed: 0, skipped: 0 });

    const snapshot = tracker.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].status).toBe("success");
    expect(snapshot[0].completed).toBe(2);
    expect(snapshot[0].total).toBe(2);
    expect(snapshot[0].resultSummary).toEqual({ succeeded: 2, failed: 0, skipped: 0 });
    expect(snapshot[0].finishedAt).not.toBeNull();
  });

  it("records failures with the error message", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "import", label: "导入", total: 3 });
    tracker.fail(id, "boom");

    const [operation] = tracker.getSnapshot();
    expect(operation.status).toBe("failed");
    expect(operation.error).toBe("boom");
    expect(operation.finishedAt).not.toBeNull();
  });

  it("notifies subscribers on every state change", () => {
    const tracker = createOperationTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);

    const id = tracker.begin({ kind: "import", label: "导入", total: 1 });
    tracker.progress(id, 1, 1);
    tracker.complete(id, { succeeded: 1, failed: 0, skipped: 0 });
    unsubscribe();
    tracker.begin({ kind: "import", label: "第二次", total: 1 });

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps the most recent operation first and caps history", () => {
    const tracker = createOperationTracker();
    for (let index = 0; index < 12; index += 1) {
      const id = tracker.begin({ kind: "import", label: `op-${index}`, total: 1 });
      tracker.complete(id, { succeeded: 1, failed: 0, skipped: 0 });
    }
    const snapshot = tracker.getSnapshot();
    expect(snapshot).toHaveLength(10);
    expect(snapshot[0].label).toBe("op-11");
  });

  it("reports whether any running operation matches a kind", () => {
    const tracker = createOperationTracker();
    expect(tracker.hasRunningKind("import")).toBe(false);

    const id = tracker.begin({ kind: "import", label: "导入 2 个 Skill", total: 2 });
    expect(tracker.hasRunningKind("import")).toBe(true);
    expect(tracker.hasRunningKind("scan")).toBe(false);

    tracker.complete(id, { succeeded: 2, failed: 0, skipped: 0 });
    expect(tracker.hasRunningKind("import")).toBe(false);

    const failedId = tracker.begin({ kind: "import", label: "导入", total: 1 });
    tracker.fail(failedId, "boom");
    expect(tracker.hasRunningKind("import")).toBe(false);
  });

  it("continues running and completes after the probing component unmounts", async () => {
    const tracker = createOperationTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { unmount } = render(<Probe tracker={tracker} />);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();

    const id = tracker.begin({ kind: "import", label: "后台导入", total: 2 });
    tracker.progress(id, 1, 2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("后台导入:running:1/2")).toBeVisible();

    // 组件卸载后循环继续：进度与完成仍写入模块级 store。
    unmount();
    await act(async () => {
      release();
      await gate;
      tracker.progress(id, 2, 2);
      tracker.complete(id, { succeeded: 1, failed: 1, skipped: 0 });
    });

    // 有成功有失败：统一生命周期落为 partial，而非笼统的 completed。
    expect(tracker.getSnapshot()[0].status).toBe("partial");
    expect(tracker.getSnapshot()[0].completed).toBe(2);
  });
});

describe("operationTracker lifecycle states (统一执行生命周期)", () => {
  it("starts in queued, treats incoming progress as running, then succeeds", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "deploy", label: "添加到 Agent", total: 2 });

    expect(tracker.getSnapshot()[0].status).toBe("queued");

    // 进度到达即证明执行已开始：queued 自动升为 running，进度不被丢弃。
    tracker.progress(id, 1, 2);
    expect(tracker.getSnapshot()[0].status).toBe("running");
    expect(tracker.getSnapshot()[0].completed).toBe(1);

    tracker.complete(id, { succeeded: 2, failed: 0, skipped: 0 });
    expect(tracker.getSnapshot()[0].status).toBe("success");
    expect(tracker.getSnapshot()[0].finishedAt).not.toBeNull();
  });

  it("marks a batch partial when some items succeed and others fail", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "deploy", label: "批量添加到 Agent", total: 3 });
    tracker.start(id);
    tracker.complete(id, { succeeded: 2, failed: 1, skipped: 0 });

    expect(tracker.getSnapshot()[0].status).toBe("partial");
    expect(tracker.getSnapshot()[0].resultSummary).toEqual({ succeeded: 2, failed: 1, skipped: 0 });
  });

  it("keeps all-failed batches as failed while preserving the summary counts", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "deploy", label: "批量添加到 Agent", total: 2 });
    tracker.start(id);
    tracker.complete(id, { succeeded: 0, failed: 2, skipped: 0 });

    expect(tracker.getSnapshot()[0].status).toBe("failed");
    expect(tracker.getSnapshot()[0].resultSummary).toEqual({ succeeded: 0, failed: 2, skipped: 0 });
  });

  it("enters needs_user with a phase and resumes to running afterwards", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "restore", label: "恢复备份", total: 1 });
    tracker.start(id);

    tracker.needsUser(id, "recovery.confirmRequired");
    expect(tracker.getSnapshot()[0].status).toBe("needs_user");
    expect(tracker.getSnapshot()[0].phase).toBe("recovery.confirmRequired");

    tracker.start(id);
    expect(tracker.getSnapshot()[0].status).toBe("running");
  });

  it("terminal states are final: progress, start and complete cannot revive a finished item", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "import", label: "导入", total: 1 });
    tracker.start(id);
    tracker.cancel(id);

    tracker.progress(id, 1, 1);
    tracker.start(id);
    tracker.complete(id, { succeeded: 1, failed: 0, skipped: 0 });

    const [operation] = tracker.getSnapshot();
    expect(operation.status).toBe("cancelled");
    expect(operation.completed).toBe(0);
  });

  it("records a cancel request on a cancellable in-flight item without ending it", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "ai_check", label: "AI 检查", total: 0, canCancel: true });
    tracker.start(id);

    tracker.requestCancel(id);
    expect(tracker.getSnapshot()[0].cancelRequested).toBe(true);
    expect(tracker.getSnapshot()[0].status).toBe("running");

    // 用户随后经后端确认取消：状态才真正落为 cancelled。
    tracker.cancel(id);
    expect(tracker.getSnapshot()[0].status).toBe("cancelled");
  });
});

describe("operationTracker correlation (同一 operation id 贯穿三端)", () => {
  it("attaches the persisted operationId, targetHref and phase for deep links", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "deploy", label: "添加到 Agent", total: 1 });
    tracker.attach(id, { operationId: "op-42", phase: "applying" });

    const [operation] = tracker.getSnapshot();
    expect(operation.operationId).toBe("op-42");
    expect(operation.targetHref).toBe("/operations/op-42");
    expect(operation.phase).toBe("applying");

    // 显式给定的 targetHref 不被默认深链覆盖。
    const customId = tracker.begin({
      kind: "deploy",
      label: "添加到 Agent",
      total: 1,
      targetHref: "/agents/agent-a",
    });
    tracker.attach(customId, { operationId: "op-43" });
    expect(tracker.getSnapshot()[0].targetHref).toBe("/agents/agent-a");
  });

  it("links child tasks to their parent so batch relations render as a family", () => {
    const tracker = createOperationTracker();
    const parentId = tracker.begin({
      kind: "relation_governance_batch",
      label: "关系治理批次",
      total: 2,
    });
    const childA = tracker.begin({
      kind: "relation_governance",
      label: "子任务 A",
      total: 1,
      parentId,
    });
    const childB = tracker.begin({
      kind: "relation_governance",
      label: "子任务 B",
      total: 1,
      parentId,
    });

    expect(tracker.getSnapshot().find((operation) => operation.id === childA)?.parentId).toBe(parentId);
    expect(tracker.getSnapshot().find((operation) => operation.id === childB)?.parentId).toBe(parentId);
    expect(tracker.getSnapshot().find((operation) => operation.id === parentId)?.parentId).toBeNull();
  });

  it("keeps progress honest when the total is unknown (percentage unavailable)", () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "ai_check", label: "AI 检查", total: 0 });
    tracker.start(id);
    tracker.progress(id, 1, 0);

    const [operation] = tracker.getSnapshot();
    expect(operation.completed).toBe(1);
    expect(operation.total).toBe(0);
    expect(operation.hasKnownTotal).toBe(false);
  });

  it("orders in-flight items newest first and drops terminal items from the in-flight paging set", () => {
    const tracker = createOperationTracker();
    const first = tracker.begin({ kind: "deploy", label: "第一项", total: 1 });
    tracker.start(first);
    const second = tracker.begin({ kind: "import", label: "第二项", total: 1 });
    tracker.start(second);

    // 多任务顺序：最新开始的在途任务排最前，即顶栏“当前项”。
    const inFlight = inFlightOperations(tracker.getSnapshot());
    expect(inFlight.map((operation) => operation.label)).toEqual(["第二项", "第一项"]);

    tracker.complete(second, { succeeded: 1, failed: 0, skipped: 0 });
    tracker.cancel(first);
    expect(inFlightOperations(tracker.getSnapshot())).toEqual([]);
  });
});
