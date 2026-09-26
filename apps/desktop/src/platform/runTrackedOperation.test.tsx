import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createOperationTracker } from "./operationTracker";
import { runTrackedOperation } from "./runTrackedOperation";
import type { AppNoticeInput, AppNotifications } from "../ui/notifications";

function stubNotifications(): AppNotifications & { notify: ReturnType<typeof vi.fn> } {
  let nextId = 0;
  return {
    notify: vi.fn((_notice: AppNoticeInput) => {
      nextId += 1;
      return `notice-${nextId}`;
    }),
    dismiss: vi.fn(),
    markRead: vi.fn(),
    notices: [],
    unreadCount: 0,
    markAllRead: vi.fn(),
    clear: vi.fn(),
    dismissByKind: vi.fn(),
  };
}

describe("runTrackedOperation", () => {
  it("runs the full lifecycle: queued → running → success, returns the result and completes the tracker", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();
    const statuses: string[] = [];
    let previous = "";
    const unsubscribe = tracker.subscribe(() => {
      const status = tracker.getSnapshot()[0]?.status ?? "";
      if (status !== previous) {
        statuses.push(status);
        previous = status;
      }
    });

    const result = await runTrackedOperation({
      tracker,
      notifications,
      kind: "deploy",
      label: "添加到 Agent",
      total: 2,
      translate: (key) => key,
      summarize: () => ({ succeeded: 2, failed: 0, skipped: 0 }),
      run: async (handle) => {
        handle.progress(1, 2);
        handle.progress(2, 2);
        handle.correlate("op-7");
        return "done" as const;
      },
    });
    unsubscribe();

    expect(result).toBe("done");
    const [operation] = tracker.getSnapshot();
    expect(operation.status).toBe("success");
    expect(operation.operationId).toBe("op-7");
    // 深链目标默认从持久化 operation id 派生：三端共用同一 id。
    expect(operation.targetHref).toBe("/operations/op-7");
    // queued → running → success 全部按顺序广播。
    expect(statuses).toEqual(["queued", "running", "success"]);
  });

  it("attaches the caller's success notice with a default deep link to the operation record", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();

    await runTrackedOperation({
      tracker,
      notifications,
      kind: "deploy",
      label: "添加到 Agent",
      translate: (key) => `t:${key}`,
      successNotice: () => ({ tone: "success", title: "已添加到 Agent" }),
      run: async (handle) => {
        handle.correlate("op-9");
        return null;
      },
    });

    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(notice.title).toBe("已添加到 Agent");
    // 通知深链到操作记录；按钮文案来自注入的翻译。
    expect(notice.action).toEqual({ label: "t:tasks.notices.viewRecord", to: "/operations/op-9" });
  });

  it("marks mixed batches partial through the shared summarize hook", async () => {
    const tracker = createOperationTracker();

    await runTrackedOperation({
      tracker,
      kind: "deploy",
      label: "批量添加到 Agent",
      total: 2,
      summarize: () => ({ succeeded: 1, failed: 1, skipped: 0 }),
      run: async () => null,
    });

    expect(tracker.getSnapshot()[0].status).toBe("partial");
  });

  it("records failures on the tracker, notifies with the deep link and rethrows the original error", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();
    const originalError = new Error("agent write protected");

    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "remove",
      label: "从 Agent 移除",
      translate: (key) => `t:${key}`,
      errorNotice: (_error, message) => ({ tone: "danger", title: "移除失败", detail: message }),
      run: async () => {
        throw originalError;
      },
    });

    // 异常不吞掉：调用方拿到原始错误对象。
    await expect(run).rejects.toBe(originalError);

    const [operation] = tracker.getSnapshot();
    expect(operation.status).toBe("failed");
    expect(operation.error).toBe("agent write protected");
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(notice.tone).toBe("danger");
    expect(notice.detail).toBe("agent write protected");
  });

  it("describes a structured native failure readably by default instead of [object Object]", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();
    // Rust 侧的 AppError 是结构化对象：没有默认描述时会被 String() 成 [object Object]。
    const structured = { code: "object.not_found", severity: "error", params: {}, actions: [] };

    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "remove",
      label: "从 Agent 移除",
      translate: (key) => `t:${key}`,
      run: async () => {
        throw structured;
      },
    });

    await expect(run).rejects.toBe(structured);

    const [operation] = tracker.getSnapshot();
    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    // 已知错误码走专属文案；顶栏失败原因与通知详情同源。
    expect(operation.error).toBe("t:errors.objectNotFound");
    expect(notice.tone).toBe("danger");
    expect(notice.detail).toBe("t:errors.objectNotFound");
    expect(notice.detail).not.toContain("[object Object]");
  });

  it("falls back to the shared generic text but still carries the error code", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();
    const seen: Array<{ key: string; options?: Record<string, unknown> }> = [];

    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "detach_relation",
      label: "从项目移除",
      translate: (key, options) => {
        seen.push({ key, options });
        return `t:${key}`;
      },
      run: async () => {
        throw { code: "relation.some_new_failure", severity: "error", params: {}, actions: [] };
      },
    });

    await expect(run).rejects.toThrow();

    const detailCall = seen.find((call) => call.key === "tasks.notices.failureUnknown");
    // 未映射的错误码必须仍然把代码带给用户，而不是退化成无信息的通用句。
    expect(detailCall?.options?.code).toBe("relation.some_new_failure");
    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(notice.detail).toBe("t:tasks.notices.failureUnknown");
    expect(notice.detail).not.toContain("[object Object]");
  });

  it("passes a plain Error message through instead of code-sniffing it", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();

    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "deploy",
      label: "添加到 Agent",
      translate: (key) => `t:${key}`,
      run: async () => {
        // 自由文本里的点号不是错误码：改写它会丢掉用户唯一能读的信息。
        throw new Error("cannot write skill.md");
      },
    });

    await expect(run).rejects.toThrow("cannot write skill.md");

    const [operation] = tracker.getSnapshot();
    expect(operation.error).toBe("cannot write skill.md");
    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(notice.detail).toBe("cannot write skill.md");
  });

  it("keeps the caller's own description when a page passes describeError", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();

    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "detach_relation",
      label: "从项目移除",
      translate: (key) => `t:${key}`,
      describeError: () => "该目录正在被其他程序占用",
      errorNotice: (_error, message) => ({ tone: "danger", title: "移除失败", detail: message }),
      run: async () => {
        throw { code: "relation.some_new_failure", severity: "error", params: {}, actions: [] };
      },
    });

    await expect(run).rejects.toThrow();

    const [operation] = tracker.getSnapshot();
    expect(operation.error).toBe("该目录正在被其他程序占用");
    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(notice.detail).toBe("该目录正在被其他程序占用");
  });

  it("invalidates the given react-query keys after a successful run", async () => {
    const tracker = createOperationTracker();
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    await runTrackedOperation({
      tracker,
      queryClient,
      invalidateQueryKeys: [["skills"], ["agents"]],
      kind: "remove",
      label: "从 Agent 移除",
      run: async () => "ok",
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["skills"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["agents"] });
  });

  it("works without a notifications service and never invents notices", async () => {
    const tracker = createOperationTracker();

    const result = await runTrackedOperation({
      tracker,
      kind: "ai_analysis",
      label: "AI 分析",
      run: async () => 42,
    });

    expect(result).toBe(42);
    expect(tracker.getSnapshot()[0].status).toBe("success");
  });

  it("keeps a default single-unit summary when the flow provides no summarize hook", async () => {
    const tracker = createOperationTracker();

    await runTrackedOperation({
      tracker,
      kind: "ai_check",
      label: "AI 检查",
      run: async () => null,
    });

    const [operation] = tracker.getSnapshot();
    expect(operation.status).toBe("success");
    expect(operation.resultSummary).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
  });

  it("forwards needsUser so blocked runs surface as needs_user in the topbar", async () => {
    const tracker = createOperationTracker();

    await runTrackedOperation({
      tracker,
      kind: "restore",
      label: "恢复备份",
      run: async (handle) => {
        handle.needsUser("recovery.confirmRequired");
        return "blocked-but-ok";
      },
    });

    // needs_user 只是途经状态：命令最终返回后仍按结果落终态。
    expect(tracker.getSnapshot()[0].status).toBe("success");
    expect(tracker.getSnapshot()[0].phase).toBe("recovery.confirmRequired");
  });

  it("emits a needs-user notice with the operation record deep link while the run is blocked", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "restore",
      label: "恢复备份",
      translate: (key) => `t:${key}`,
      run: async (handle) => {
        // 持久化 operation id 在 prepare 后即已知，随后执行才阻塞。
        handle.correlate("op-77");
        handle.needsUser("recovery.confirmRequired");
        await gate;
        return "done";
      },
    });

    // 阻塞期间即发通知，不等命令结束。
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(notice.tone).toBe("info");
    expect(notice.detail).toBe("recovery.confirmRequired");
    expect(notice.action).toEqual({ label: "t:tasks.notices.viewRecord", to: "/operations/op-77" });

    release();
    await run;
  });

  it("finalizes as cancelled (not failed) when the user cancellation was confirmed via markCancelled", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();
    const cancellation = new Error("operation cancelled");

    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "ai_check",
      label: "AI 检查",
      canCancel: true,
      errorNotice: () => null,
      run: async (handle) => {
        // 后端确认取消后命令以异常收场：终态必须是 cancelled。
        handle.markCancelled();
        throw cancellation;
      },
    });

    await expect(run).rejects.toBe(cancellation);
    expect(tracker.getSnapshot()[0].status).toBe("cancelled");
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("does not report a confirmed cancellation as a failure notice for callers that map failures", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();
    const cancellation = new Error("operation cancelled");

    // 真实调用方（如 AI 检查）都会给失败映射一个 danger 通知；取消不是失败，
    // 该映射在取消路径上不得生效——否则用户主动取消后会收到红色“失败”提示。
    const run = runTrackedOperation({
      tracker,
      notifications,
      kind: "ai_check",
      label: "AI 检查",
      canCancel: true,
      errorNotice: (_error, message) => ({ tone: "danger", title: "AI 检查失败", detail: message }),
      run: async (handle) => {
        handle.requestCancel();
        handle.markCancelled();
        throw cancellation;
      },
    });

    await expect(run).rejects.toBe(cancellation);
    expect(tracker.getSnapshot()[0].status).toBe("cancelled");
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("does not flash the topbar for instant commands: no tracker entry and only a result notice", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();

    await runTrackedOperation({
      tracker,
      notifications,
      kind: "set_metadata",
      label: "保存标签",
      mode: "instant",
      translate: (key) => `t:${key}`,
      successNotice: () => ({ tone: "success", title: "标签已保存" }),
      run: async () => "saved",
    });

    // 即时写入不进入在途投影：顶栏不能为已经返回的命令闪烁。
    expect(tracker.getSnapshot()).toEqual([]);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  // DEV-96：通知必须能回答「属于哪个模块」——桥统一注入 source，
  // 调用方显式给的值优先，不得被桥覆盖。
  it("injects the flow source into success, failure and needs-user notices unless the caller set one", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();

    await runTrackedOperation({
      tracker,
      notifications,
      kind: "agent_rescan",
      label: "重新扫描",
      source: "discovery",
      translate: (key) => `t:${key}`,
      successNotice: () => ({ tone: "success", title: "重新扫描" }),
      run: async () => null,
    });
    await runTrackedOperation({
      tracker,
      notifications,
      kind: "remove",
      label: "从 Agent 移除",
      source: "library",
      translate: (key) => `t:${key}`,
      run: async () => {
        throw new Error("write protected");
      },
    }).catch(() => undefined);
    await runTrackedOperation({
      tracker,
      notifications,
      kind: "restore",
      label: "恢复备份",
      source: "system",
      translate: (key) => `t:${key}`,
      run: async (handle) => {
        handle.needsUser("recovery.confirmRequired");
        return null;
      },
    });

    const [success, failure, blocked] = notifications.notify.mock.calls
      .map((call) => call[0] as AppNoticeInput);
    expect(success.source).toBe("discovery");
    expect(failure.source).toBe("library");
    expect(blocked.source).toBe("system");

    // 调用方显式给出的 source 优先于桥的缺省注入。
    await runTrackedOperation({
      tracker,
      notifications,
      kind: "deploy",
      label: "添加到 Agent",
      source: "deployment",
      translate: (key) => `t:${key}`,
      successNotice: () => ({ tone: "success", title: "已添加", source: "library" }),
      run: async () => null,
    });
    const override = notifications.notify.mock.calls.at(-1)![0] as AppNoticeInput;
    expect(override.source).toBe("library");
  });

  it("leaves notices without a flow source untouched so the history groups them as system", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();

    await runTrackedOperation({
      tracker,
      notifications,
      kind: "ai_check",
      label: "AI 检查",
      translate: (key) => `t:${key}`,
      run: async () => null,
    });

    const notice = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(notice.source).toBeUndefined();
  });

  // DEV-96：批量结果必须回答「结果是什么」——多单位或有失败时，桥为
  // 未写 detail 的成功通知补「成功 N、失败 M」；调用方自己的 detail 不被覆盖。
  it("adds a batch result summary detail to multi-unit or partial success notices", async () => {
    const tracker = createOperationTracker();
    const notifications = stubNotifications();

    await runTrackedOperation({
      tracker,
      notifications,
      kind: "deploy",
      label: "批量添加到 Agent",
      total: 3,
      translate: (key, options) => `t:${key}:${JSON.stringify(options)}`,
      summarize: () => ({ succeeded: 2, failed: 1, skipped: 0 }),
      run: async () => null,
    });
    await runTrackedOperation({
      tracker,
      notifications,
      kind: "deploy",
      label: "添加到 Agent",
      translate: (key) => `t:${key}`,
      successNotice: () => ({ tone: "success", title: "已添加", detail: "自定义说明" }),
      run: async () => null,
    });

    const batch = notifications.notify.mock.calls[0][0] as AppNoticeInput;
    expect(batch.detail).toBe('t:tasks.notices.batchResult:{"succeeded":2,"failed":1}');
    const single = notifications.notify.mock.calls[1][0] as AppNoticeInput;
    expect(single.detail).toBe("自定义说明");
  });
});
