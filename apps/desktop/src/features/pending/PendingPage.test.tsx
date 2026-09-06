import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
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
  expect(screen.getByText(/创建于：2026-09-01T10:00:00\+08:00/)).toBeInTheDocument();
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
