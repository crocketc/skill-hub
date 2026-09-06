import { act, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import { createOperationTracker } from "./operationTracker";

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
    expect(snapshot[0].status).toBe("completed");
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

    expect(tracker.getSnapshot()[0].status).toBe("completed");
    expect(tracker.getSnapshot()[0].completed).toBe(2);
  });
});
