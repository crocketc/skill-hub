import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import type { HandledEntry, PendingFacade, PendingItem } from "./api";
import { PendingPage } from "./PendingPage";

function fakeFacade(overrides: Partial<PendingFacade> = {}): PendingFacade {
  return {
    list: async () => [],
    resolve: async () => undefined,
    recheck: async () => undefined,
    convert: async () => undefined,
    remove: async () => undefined,
    recover: async () => undefined,
    defer: async () => undefined,
    ignore: async () => undefined,
    listHandled: async () => [] as HandledEntry[],
    unignore: async () => undefined,
    loadSavedView: async () => null,
    saveSavedView: async () => undefined,
    ...overrides,
  };
}

const trialItem: PendingItem = {
  id: "trial_due:skill-a:trial",
  subject: "skill-a",
  kind: "trial_due",
  code: "trial",
  message: "trial",
  dueDate: "2026-09-30",
  affectedDeployments: 2,
};

const findingItem: PendingItem = {
  id: "security_finding:skill-b:finding-7",
  subject: "skill-b",
  kind: "security_finding",
  code: "finding-7",
  message: "finding",
  risk: "high",
  affectedDeployments: 3,
};

async function renderPage(facade: PendingFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<I18nextProvider i18n={i18n}><PendingPage facade={facade} /></I18nextProvider>);
  // 刷新挂载时的异步加载（list / listHandled / loadSavedView），避免 act 告警。
  await act(async () => {});
}

// T3-C「每路由唯一 h1」（任务 10 h1 sweep）：待处理页自持 route-level h1。
it("keeps a single page-level h1 for the pending heading outline", async () => {
  await renderPage(fakeFacade());

  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1, name: "完成待处理事项" })).toBeVisible();
});

it("does not offer a generic delete action for pending work", async () => {
  await renderPage(fakeFacade({
    list: async () => [{ id: "trial", subject: "skill-a", kind: "trial_due", code: "trial", message: "trial" }],
  }));
  await screen.findByText("skill-a");
  expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
});

it("filters pending work by its actual kind", async () => {
  await renderPage(fakeFacade({
    list: async () => [
      { id: "trial", subject: "skill-a", kind: "trial_due", code: "trial", message: "trial" },
      { id: "recovery", subject: "未完成部署", kind: "recovery", code: "recovery", message: "recovery" },
    ],
  }));
  await screen.findByText("skill-a");

  fireEvent.change(screen.getByLabelText("事项类型"), { target: { value: "recovery" } });

  expect(screen.getByText("未完成部署")).toBeInTheDocument();
  expect(screen.queryByText("skill-a")).not.toBeInTheDocument();
});

it("prevents duplicate pending actions while one item is being processed", async () => {
  let release: (() => void) | undefined;
  const convert = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  await renderPage(fakeFacade({
    list: async () => [{ id: "trial", subject: "skill-a", kind: "trial_due", code: "trial", message: "trial" }],
    convert,
  }));
  const action = await screen.findByRole("button", { name: "转为常规" });

  fireEvent.click(action);
  expect(convert).toHaveBeenCalledTimes(1);
  expect(action).toBeDisabled();

  await act(async () => { release?.(); });
});

it("shows due date, risk badge and deployment impact per item", async () => {
  await renderPage(fakeFacade({
    list: async () => [trialItem, findingItem],
  }));
  await screen.findByText("skill-a");

  expect(screen.getByText("到期日：2026-09-30")).toBeInTheDocument();
  expect(screen.getByText("影响 2 个部署关系")).toBeInTheDocument();
  const riskBadge = screen.getByText("高风险");
  expect(riskBadge).toHaveClass("sh-pending-item__risk--high");
  expect(screen.getByText("影响 3 个部署关系")).toBeInTheDocument();
});

it("defers a single item for the chosen days with a generated reason and refreshes the list", async () => {
  let calls = 0;
  const list = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? [trialItem] : [];
  });
  const defer = vi.fn(async () => undefined);
  await renderPage(fakeFacade({ list, defer }));
  await screen.findByText("skill-a");

  const row = screen.getByText("skill-a").closest("li") as HTMLElement;
  fireEvent.change(within(row).getByLabelText("暂缓时长"), { target: { value: "7" } });
  fireEvent.click(within(row).getByRole("button", { name: "暂缓" }));

  await waitFor(() => expect(defer).toHaveBeenCalledTimes(1));
  expect(defer).toHaveBeenCalledWith(
    [expect.objectContaining({ id: "trial_due:skill-a:trial" })],
    7,
    expect.stringMatching(/\S/),
  );
  await screen.findByText("没有待处理事项");
  expect(list).toHaveBeenCalledTimes(2);
});

it("ignores a single item permanently only after an explicit confirmation", async () => {
  const ignore = vi.fn(async () => undefined);
  await renderPage(fakeFacade({
    list: async () => [findingItem],
    ignore,
  }));
  await screen.findByText("skill-b");

  fireEvent.click(screen.getByRole("button", { name: "忽略" }));
  expect(await screen.findByRole("alertdialog", { name: "永久忽略该事项？" })).toBeInTheDocument();
  expect(ignore).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "确认忽略" }));
  await act(async () => {});
  await waitFor(() => expect(ignore).toHaveBeenCalledTimes(1));
  expect(ignore).toHaveBeenCalledWith(
    [expect.objectContaining({ id: "security_finding:skill-b:finding-7" })],
    expect.stringMatching(/\S/),
  );
});

it("defers every selected item from the batch bar with visible progress", async () => {
  const gates: Array<() => void> = [];
  const defer = vi.fn((_items: PendingItem[], _days: number, _reason: string) => new Promise<void>((resolve) => { gates.push(resolve); }));
  await renderPage(fakeFacade({
    list: async () => [trialItem, findingItem],
    defer,
  }));
  await screen.findByText("skill-a");

  fireEvent.click(screen.getByLabelText("选择 skill-a"));
  fireEvent.click(screen.getByLabelText("选择 skill-b"));
  fireEvent.click(screen.getByRole("button", { name: "批量暂缓 7 天" }));

  expect(await screen.findByText("正在处理 0/2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "批量暂缓 7 天" })).toBeDisabled();

  await act(async () => { gates[0]?.(); });
  expect(await screen.findByText("正在处理 1/2")).toBeInTheDocument();
  await act(async () => { gates[1]?.(); });

  await waitFor(() => expect(screen.queryByText(/正在处理/)).not.toBeInTheDocument());
  expect(defer).toHaveBeenCalledTimes(2);
  const deferredIds = defer.mock.calls.map((call) => call[0][0]?.id).sort();
  expect(deferredIds).toEqual(["security_finding:skill-b:finding-7", "trial_due:skill-a:trial"]);
  for (const call of defer.mock.calls) {
    expect(call[1]).toBe(7);
    expect(String(call[2]).trim()).not.toBe("");
  }
});

it("requires confirmation before batch permanent ignore and does nothing on cancel", async () => {
  const ignore = vi.fn(async (_items: PendingItem[], _reason: string) => undefined);
  await renderPage(fakeFacade({
    list: async () => [trialItem, findingItem],
    ignore,
  }));
  await screen.findByText("skill-a");

  fireEvent.click(screen.getByLabelText("选择 skill-a"));
  fireEvent.click(screen.getByLabelText("选择 skill-b"));
  fireEvent.click(screen.getByRole("button", { name: "批量永久忽略" }));

  expect(await screen.findByRole("alertdialog", { name: "永久忽略所选事项？" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(ignore).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "批量永久忽略" }));
  await screen.findByRole("alertdialog", { name: "永久忽略所选事项？" });
  fireEvent.click(screen.getByRole("button", { name: "确认批量忽略" }));

  await waitFor(() => expect(ignore).toHaveBeenCalledTimes(2));
  const ignoredIds = ignore.mock.calls.map((call) => call[0][0]?.id).sort();
  expect(ignoredIds).toEqual(["security_finding:skill-b:finding-7", "trial_due:skill-a:trial"]);
});

it("renders handled history and undoes an entry", async () => {
  const listHandled = vi.fn(async () => [
    { id: "rule-1", pendingId: "trial_due:skill-a:trial", reason: "暂缓 7 天后再提醒", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: "2026-09-08" },
  ]);
  const unignore = vi.fn(async () => undefined);
  await renderPage(fakeFacade({ listHandled, unignore }));

  await screen.findByText("处理历史");
  await screen.findByText("trial_due:skill-a:trial");
  expect(screen.getByText("暂缓 7 天后再提醒")).toBeInTheDocument();
  // T4-A：历史时间戳必须经 Intl.DateTimeFormat 本地化，不再展示原始 ISO 字符串。
  expect(screen.queryByText(/2026-09-01T10:00:00/)).not.toBeInTheDocument();
  expect(screen.getByText(/创建于：2026年9月1日/)).toBeInTheDocument();
  expect(screen.getByText(/暂缓截止：2026-09-08/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "撤销" }));

  await waitFor(() => expect(unignore).toHaveBeenCalledWith("rule-1"));
  await waitFor(() => expect(listHandled).toHaveBeenCalledTimes(2));
});

it("shows an honest handled history empty state", async () => {
  await renderPage(fakeFacade({ listHandled: async () => [] }));
  expect(await screen.findByText("暂无暂缓/忽略记录。")).toBeInTheDocument();
});

it("reports handled history load failures through the native error description", async () => {
  await renderPage(fakeFacade({
    listHandled: async () => { throw "boom"; },
  }));
  expect(await screen.findByText("操作失败（unknown）。请稍后重试。")).toBeInTheDocument();
});

it("restores the saved view on mount and persists kind changes", async () => {
  const loadSavedView = vi.fn(async () => "recovery" as string | null);
  const saveSavedView = vi.fn(async () => undefined);
  await renderPage(fakeFacade({
    list: async () => [
      trialItem,
      { id: "recovery:op-2:recovery", subject: "未完成部署", kind: "recovery", code: "recovery", message: "recovery" },
    ],
    loadSavedView,
    saveSavedView,
  }));

  await screen.findByText("未完成部署");
  await act(async () => {});
  expect(loadSavedView).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText("skill-a")).not.toBeInTheDocument());

  fireEvent.change(screen.getByLabelText("事项类型"), { target: { value: "all" } });
  await act(async () => {});
  await waitFor(() => expect(saveSavedView).toHaveBeenCalledWith("all"));
  expect(screen.getByText("skill-a")).toBeInTheDocument();
});

it("exposes each item's suggested actions as a named group after its risk and impact", async () => {
  await renderPage(fakeFacade({ list: async () => [findingItem] }));
  await screen.findByText("skill-b");

  const group = screen.getByRole("group", { name: "处理 skill-b 的建议操作" });
  expect(within(group).getByRole("button", { name: "重新检查" })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "暂缓" })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "忽略" })).toBeInTheDocument();
});

it("keeps the list usable and reports one failed action without replacing the page", async () => {
  const defer = vi.fn(async () => {
    throw "permission denied";
  });
  await renderPage(fakeFacade({ list: async () => [trialItem, findingItem], defer }));
  await screen.findByText("skill-a");

  const row = screen.getByText("skill-a").closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "暂缓" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("操作失败");
  expect(screen.getByText("skill-a")).toBeInTheDocument();
  expect(screen.getByText("skill-b")).toBeInTheDocument();
  expect(within(row).getByRole("button", { name: "暂缓" })).toBeEnabled();
});

it("announces how many items are selected in the batch bar", async () => {
  await renderPage(fakeFacade({ list: async () => [trialItem, findingItem] }));
  await screen.findByText("skill-a");

  fireEvent.click(screen.getByLabelText("选择 skill-a"));
  expect(screen.getByText("已选 1 项")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("选择 skill-b"));
  expect(screen.getByText("已选 2 项")).toBeInTheDocument();
});

// 统一执行桥（任务 4 最后一个未收口入口）：处置写入（单条/批量/撤销）进
// runTrackedOperation——单条即时写入不占在途顶栏，批量进 phased 在途投影；
// 通知详情与页面局部提示同源，结构化 AppError 不允许 [object Object]。
async function renderBridgedPage(facade: PendingFacade, tracker: OperationTracker = createOperationTracker()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <AppNotificationsProvider>
        <PendingPage facade={facade} tracker={tracker} />
      </AppNotificationsProvider>
    </I18nextProvider>,
  );
  await act(async () => {});
  return tracker;
}

it("notifies a successful single disposition through the unified bridge", async () => {
  let calls = 0;
  const list = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? [trialItem] : [];
  });
  const defer = vi.fn(async () => undefined);
  await renderBridgedPage(fakeFacade({ list, defer }));
  await screen.findByText("skill-a");

  const row = screen.getByText("skill-a").closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "暂缓" }));

  const toast = await screen.findByTestId("notice-success");
  expect(toast).toHaveTextContent("暂缓");
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

it("renders a structured single-write failure readably and identically in notice and page", async () => {
  const defer = vi.fn(async () => {
    throw { code: "io.denied" };
  });
  await renderBridgedPage(fakeFacade({ list: async () => [trialItem], defer }));
  await screen.findByText("skill-a");

  const row = screen.getByText("skill-a").closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "暂缓" }));

  const readable = "操作失败（io.denied）。请稍后重试。";
  const toast = await screen.findByTestId("notice-danger");
  expect(toast).toHaveTextContent(readable);
  expect(toast).not.toHaveTextContent("[object Object]");
  await waitFor(() => {
    const pageAlert = screen.getAllByRole("alert").find((el) => el.getAttribute("data-testid") === null);
    expect(pageAlert).toHaveTextContent(readable);
  });
});

it("projects the batch onto the tracker and reports a counted success notice", async () => {
  const gates: Array<() => void> = [];
  const defer = vi.fn((_items: PendingItem[], _days: number, _reason: string) => new Promise<void>((resolve) => { gates.push(resolve); }));
  const tracker = await renderBridgedPage(fakeFacade({ list: async () => [trialItem, findingItem], defer }));
  await screen.findByText("skill-a");

  fireEvent.click(screen.getByLabelText("选择 skill-a"));
  fireEvent.click(screen.getByLabelText("选择 skill-b"));
  fireEvent.click(screen.getByRole("button", { name: "批量暂缓 7 天" }));

  await waitFor(() => {
    const inFlight = tracker.getSnapshot().filter((op) => op.status === "queued" || op.status === "running");
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]?.label).toBe("批量暂缓 7 天");
  });
  expect(screen.getByText("正在处理 0/2")).toBeInTheDocument();

  await act(async () => { gates[0]?.(); });
  await act(async () => { gates[1]?.(); });

  const toast = await screen.findByTestId("notice-success");
  expect(toast).toHaveTextContent("批量暂缓 7 天");
  expect(toast).toHaveTextContent("已处理 2 项");
  await waitFor(() => {
    const ops = tracker.getSnapshot();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.status).toBe("success");
    expect(ops[0]?.resultSummary).toEqual({ succeeded: 2, failed: 0, skipped: 0 });
  });
});

it("reports a mid-batch failure readably in notice, page and tracker terminal state", async () => {
  const defer = vi.fn(async (_items: PendingItem[], _days: number, _reason: string) => {
    if (defer.mock.calls.length === 2) throw { code: "io.denied" };
  });
  const list = vi.fn(async () => [trialItem, findingItem]);
  const tracker = await renderBridgedPage(fakeFacade({ list, defer }));
  await screen.findByText("skill-a");

  fireEvent.click(screen.getByLabelText("选择 skill-a"));
  fireEvent.click(screen.getByLabelText("选择 skill-b"));
  fireEvent.click(screen.getByRole("button", { name: "批量暂缓 7 天" }));

  const readable = "操作失败（io.denied）。请稍后重试。";
  const toast = await screen.findByTestId("notice-danger");
  expect(toast).toHaveTextContent(readable);
  expect(toast).not.toHaveTextContent("[object Object]");
  expect(screen.getAllByRole("alert").map((el) => el.textContent)).toContain(readable);
  await waitFor(() => {
    const ops = tracker.getSnapshot();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.status).toBe("failed");
    expect(ops[0]?.error).toBe(readable);
  });
  // 首错即停：第二项失败后不再继续，但已完成的第一项保留（刷新反映真实进度）。
  expect(defer).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

it("notifies a successful handled-entry undo through the bridge", async () => {
  const listHandled = vi.fn(async () => [
    { id: "rule-1", pendingId: "trial_due:skill-a:trial", reason: "暂缓 7 天后再提醒", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: "2026-09-08" },
  ]);
  const unignore = vi.fn(async () => undefined);
  await renderBridgedPage(fakeFacade({ listHandled, unignore }));
  await screen.findByText("trial_due:skill-a:trial");

  fireEvent.click(screen.getByRole("button", { name: "撤销" }));

  const toast = await screen.findByTestId("notice-success");
  expect(toast).toHaveTextContent("撤销");
  await waitFor(() => expect(listHandled).toHaveBeenCalledTimes(2));
});
