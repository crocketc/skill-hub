import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import type { HandledEntry, PendingFacade, PendingItem } from "./api";
import { PendingPage } from "./PendingPage";
import { MemoryRouter, useLocation } from "react-router-dom";

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
  subject: "skill-a", displayName: "skill-a",
  kind: "trial_due",
  code: "trial",
  message: "trial",
  dueDate: "2026-09-30",
  affectedDeployments: 2,
};

const findingItem: PendingItem = {
  id: "security_finding:skill-b:finding-7",
  subject: "skill-b", displayName: "skill-b",
  kind: "security_finding",
  code: "finding-7",
  findingId: "finding-7",
  message: "finding",
  risk: "high",
  affectedDeployments: 3,
};

const optionalItem: PendingItem = { ...findingItem, id: "work:ai_setup:settings:first", kind: "ai_setup", recommended: true };

it("links required work to its source without exposing identifiers or offering ignore", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade = fakeFacade({ list: async () => [{
    id: "conflict:internal-case", subject: "internal-case", kind: "conflict",
    code: "conflict", message: "pending.reasons.conflict", displayName: "Notes",
    href: "/relationships/decisions?conflictId=internal-case", canSnooze: false,
  }] });
  render(<MemoryRouter><I18nextProvider i18n={i18n}><PendingPage facade={facade} /></I18nextProvider></MemoryRouter>);
  expect(await screen.findByRole("button", { name: "查看事项明细: 技能冲突" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看事项明细: 技能冲突" }));
  const exactLink = document.querySelector<HTMLAnchorElement>('.sh-pending-item a[href="/relationships/decisions?conflictId=internal-case"]');
  expect(exactLink).toBeInTheDocument();
  expect(screen.queryByText("internal-case")).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "选择 Notes" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "忽略" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "批量暂缓 7 天" })).toBeDisabled();
});

it("refreshes resolved work on window focus and retries a failed source", async () => {
  const list = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([trialItem]).mockResolvedValue([]);
  await renderPage(fakeFacade({ list }));
  fireEvent.click(await screen.findByRole("button", { name: "刷新待办" }));
  // 刷新后组行重新收拢：等组出现再展开，才能看到组内对象明细。
  expect(await screen.findByRole("button", { name: "查看事项明细: 试用复核" })).toBeVisible();
  expandPendingGroups();
  expect(await screen.findByText("skill-a")).toBeVisible();
  fireEvent(window, new Event("focus"));
  expect(await screen.findByText("没有待处理事项")).toBeVisible();
});

it("keeps the explicit overview category ahead of a saved filter", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade = fakeFacade({ loadSavedView: async () => "trial_due", list: async () => [trialItem] });
  render(<MemoryRouter><I18nextProvider i18n={i18n}><PendingPage facade={facade} initialKind="conflict" /></I18nextProvider></MemoryRouter>);
  expect(await screen.findByLabelText("具体事项")).toHaveValue("conflict");
  expect(screen.queryByText("skill-a")).not.toBeInTheDocument();
});

async function renderPage(facade: PendingFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<MemoryRouter><I18nextProvider i18n={i18n}><PendingPage facade={facade} /></I18nextProvider></MemoryRouter>);
  // 刷新挂载时的异步加载（list / listHandled / loadSavedView），避免 act 告警。
  await act(async () => {});
  expandPendingGroups();
}

/** 组行默认收拢：验证不展开即可读的组行事实时使用。 */
async function renderCollapsedPage(facade: PendingFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<MemoryRouter><I18nextProvider i18n={i18n}><PendingPage facade={facade} /></I18nextProvider></MemoryRouter>);
  await act(async () => {});
}

function LocationStateProbe() {
  const location = useLocation();
  return <output data-testid="route-state">{JSON.stringify(location.state ?? {})}</output>;
}

function expandPendingGroups() {
  for (const toggle of screen.queryAllByRole("button", { name: /^查看事项明细/ })) fireEvent.click(toggle);
}

// T3-C「每路由唯一 h1」（任务 10 h1 sweep）：待处理页自持 route-level h1。
it("keeps a single page-level h1 for the pending heading outline", async () => {
  await renderPage(fakeFacade());

  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1, name: "完成待处理事项" })).toBeVisible();
});

it("keeps work groups compact until opened and hands valid Skill selections back with current filters", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade = fakeFacade({ list: async () => [
    { id: "basic-a", subject: "skill-a", displayName: "PDF Reader", kind: "basic_check", code: "basic", message: "基础检查", canSnooze: false },
    { id: "medium-a", subject: "skill-a", displayName: "PDF Reader", kind: "security_finding", code: "medium", message: "中风险发现", risk: "medium", canSnooze: false },
    { id: "high-b", subject: "skill-b", displayName: "PDF Reader Pro", kind: "security_finding", code: "high", message: "高风险发现", risk: "high", canSnooze: false },
    { id: "source-c", subject: "skill-c", displayName: "PDF Source", kind: "source_update", code: "source", message: "来源有更新", canSnooze: true },
  ] });
  render(<MemoryRouter initialEntries={["/pending?category=skill_review&search=pdf"]}><I18nextProvider i18n={i18n}><PendingPage facade={facade} /><LocationStateProbe /></I18nextProvider></MemoryRouter>);
  await screen.findByRole("heading", { name: "待处理工作台" });

  const groupToggle = screen.getByRole("button", { name: "查看事项明细: 安全与基础检查" });
  expect(groupToggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("checkbox", { name: "选择 PDF Reader" })).not.toBeInTheDocument();
  fireEvent.click(groupToggle);
  expect(screen.getAllByRole("checkbox", { name: "选择 PDF Reader" })).toHaveLength(2);
  const batchLink = screen.getByRole("link", { name: "到技能库批量检查 (1)" });
  expect(batchLink).toBeVisible();

  fireEvent.click(batchLink);
  const routeState = JSON.parse(screen.getByTestId("route-state").textContent ?? "{}") as { pendingReview?: { skillIds: string[]; intent: string; returnTo: string } };
  expect(routeState.pendingReview).toEqual({
    skillIds: ["skill-a"],
    intent: "security_check",
    returnTo: "/pending?category=skill_review&search=pdf",
  });
});

it("summarizes involved objects, counts and the highest risk on the collapsed group row", async () => {
  await renderCollapsedPage(fakeFacade({
    list: async () => [
      { id: "medium-a", subject: "skill-a", displayName: "PDF Reader", kind: "security_finding", code: "medium", message: "中风险发现", risk: "medium", canSnooze: false },
      { id: "basic-b", subject: "skill-b", displayName: "PDF Reader Pro", kind: "basic_check", code: "basic", message: "基础检查", canSnooze: false },
      { id: "trial-a", subject: "skill-a", displayName: "PDF Reader", kind: "trial_due", code: "trial", message: "试用到期" },
    ],
  }));
  await screen.findByRole("heading", { name: "待处理工作台" });

  const securityToggle = screen.getByRole("button", { name: "查看事项明细: 安全与基础检查" });
  expect(securityToggle).toHaveAttribute("aria-expanded", "false");
  const securityGroup = securityToggle.closest("li") as HTMLElement;
  // 组行不展开就给出真实事项数、对象摘要与最高风险，且不得出现技术标识。
  expect(within(securityGroup).getByText("2 项待办")).toBeVisible();
  expect(within(securityGroup).getByText("涉及 2 个对象")).toBeVisible();
  expect(within(securityGroup).getByText("PDF Reader")).toBeVisible();
  expect(within(securityGroup).getByText("PDF Reader Pro")).toBeVisible();
  expect(within(securityGroup).getByText("中风险")).toBeVisible();
  expect(within(securityGroup).queryByText("高风险")).not.toBeInTheDocument();
  expect(within(securityGroup).queryByText("skill-a")).not.toBeInTheDocument();
  // 逐项明细（含选择与操作）仍要等展开后才出现。
  expect(within(securityGroup).queryByRole("checkbox", { name: "选择 PDF Reader" })).not.toBeInTheDocument();
  // 历史入口在聚合视图下保持可达。
  expect(screen.getByRole("link", { name: /处理历史/ })).toHaveAttribute("href", "#pending-history-heading");
});

it("moves the handled-history link into the batch disposition group", async () => {
  const listHandled = vi.fn(async () => [
    { id: "rule-1", pendingId: "trial_due:skill-a:trial", reason: "暂缓 7 天后再提醒", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: "2026-09-08" },
  ]);
  await renderCollapsedPage(fakeFacade({ list: async () => [trialItem], listHandled }));
  await screen.findByRole("heading", { name: "待处理工作台" });

  // 历史入口归属批量处置组（钉顶常驻），保留锚点 href 与带计数的可访问名称。
  const batchGroup = screen.getByRole("group", { name: "批量处置" });
  const historyLink = within(batchGroup).getByRole("link", { name: /处理历史/ });
  expect(historyLink).toHaveAttribute("href", "#pending-history-heading");
  expect(historyLink).toHaveTextContent("处理历史 (1)");

  // 分类组回归纯筛选职责，不再承载历史入口。
  const categories = screen.getByRole("group", { name: "全部" });
  expect(within(categories).queryByRole("link")).not.toBeInTheDocument();
});

it("keeps high-risk reasons visible before expanding with an exact deep link", async () => {
  await renderCollapsedPage(fakeFacade({
    list: async () => [
      { id: "basic-a", subject: "skill-a", displayName: "PDF Reader", kind: "basic_check", code: "basic", message: "基础检查", canSnooze: false },
      { id: "high-b", subject: "skill-b", displayName: "PDF Reader Pro", kind: "security_finding", code: "high", message: "高风险发现", risk: "high", canSnooze: false },
    ],
  }));
  await screen.findByRole("heading", { name: "待处理工作台" });

  const securityGroup = screen.getByRole("button", { name: "查看事项明细: 安全与基础检查" }).closest("li") as HTMLElement;
  const reasons = within(securityGroup).getByRole("list", { name: "高风险原因（1 项）" });
  expect(reasons).toBeVisible();
  expect(within(reasons).getByText(/PDF Reader Pro/)).toBeVisible();
  expect(within(reasons).getByRole("link", { name: "去处理" })).toHaveAttribute("href", "/library/skill-b/security");
  expect(within(securityGroup).getAllByText("高风险").length).toBeGreaterThan(0);
});

it("maps group selection onto exact snoozable items and keeps source-work groups out of batch", async () => {
  const defer = vi.fn(async (_items: PendingItem[], _days: number, _reason: string) => undefined);
  await renderPage(fakeFacade({
    list: async () => [
      trialItem,
      findingItem,
      { id: "recovery:op-1:recovery", subject: "op-1", displayName: "未完成部署", kind: "recovery", code: "recovery", message: "recovery" },
    ],
    defer,
  }));
  await screen.findByRole("heading", { name: "待处理工作台" });

  // 安全发现与恢复事项没有可批量契约：组选择禁用，不能借组进入批量忽略。
  const lockedGroupChecks = screen.getAllByRole("checkbox", { name: "选择此组中可批量处理的 0 项" });
  expect(lockedGroupChecks).toHaveLength(2);
  for (const checkbox of lockedGroupChecks) expect(checkbox).toBeDisabled();

  // 试用组整组选择只映射到该组可暂缓的精确事项。
  fireEvent.click(screen.getByRole("checkbox", { name: "选择此组中可批量处理的 1 项" }));
  expect(screen.getByText("已选 1 项")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "批量暂缓 7 天" }));
  await waitFor(() => expect(defer).toHaveBeenCalledTimes(1));
  expect(defer.mock.calls[0]?.[0].map((item: PendingItem) => item.id)).toEqual(["trial_due:skill-a:trial"]);
});

it("marks a partially selected group as indeterminate instead of fully checked", async () => {
  const secondTrial: PendingItem = { ...trialItem, id: "trial_due:skill-b:trial", subject: "skill-b", displayName: "skill-b" };
  await renderPage(fakeFacade({ list: async () => [trialItem, secondTrial] }));
  await screen.findByRole("heading", { name: "待处理工作台" });

  const groupCheckbox = screen.getByRole("checkbox", { name: "选择此组中可批量处理的 2 项" }) as HTMLInputElement;
  expect(groupCheckbox.checked).toBe(false);
  expect(groupCheckbox.indeterminate).toBe(false);

  fireEvent.click(screen.getByLabelText("选择 skill-a"));
  expect(groupCheckbox.checked).toBe(false);
  expect(groupCheckbox.indeterminate).toBe(true);

  fireEvent.click(screen.getByLabelText("选择 skill-b"));
  expect(groupCheckbox.checked).toBe(true);
  expect(groupCheckbox.indeterminate).toBe(false);
});

it("caps collapsed object summaries and keeps exact counts for large review groups", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `trial-${index}`, subject: `skill-${index}`, displayName: `Skill ${index}`, kind: "trial_due", code: "trial", message: "试用到期",
  })) as PendingItem[];
  await renderCollapsedPage(fakeFacade({ list: async () => items }));
  await screen.findByRole("heading", { name: "待处理工作台" });

  const group = screen.getByRole("button", { name: "查看事项明细: 试用复核" }).closest("li") as HTMLElement;
  expect(within(group).getByText("5 项待办")).toBeVisible();
  expect(within(group).getByText("涉及 5 个对象")).toBeVisible();
  // 折叠摘要最多点名 3 个对象，其余以 +N 汇总，不展开成几十行。
  expect(within(group).getByText("Skill 2")).toBeVisible();
  expect(within(group).queryByText("Skill 3")).not.toBeInTheDocument();
  expect(within(group).getByText("+2")).toBeVisible();
});

it("merges same-target compatibility modes into one branded card and dedupes shared-directory brands", async () => {
  const copyItem: PendingItem = {
    id: "compat:target-a:managed_copy", subject: "target-a", kind: "agent_compatibility", code: "agent_compatibility",
    message: "pending.reasons.agent_compatibility", displayName: "CodeBuddy", agentBrand: "CodeBuddy", agentKinds: ["cli"],
    checkKind: "managed_copy", path: "C:/Users/demo/.codebuddy/skills", canSnooze: false,
  };
  const linkItem: PendingItem = { ...copyItem, id: "compat:target-a:symbolic_link", checkKind: "symbolic_link" };
  const sharedFirst: PendingItem = {
    id: "compat:shared-1:a", subject: "shared-1", kind: "agent_compatibility", code: "agent_compatibility",
    message: "pending.reasons.agent_compatibility", displayName: "OpenAI", agentDirectoryKey: "verified_physical:dir-1",
    agentSharedDirectory: true, agentSharedBrands: ["Anthropic", "OpenAI"], agentSharedBrandKinds: { Anthropic: ["cli"], OpenAI: ["desktop"] },
    checkKind: "managed_copy", canSnooze: false,
  };
  const sharedSecond: PendingItem = { ...sharedFirst, id: "compat:shared-1:b", subject: "shared-2", displayName: "Anthropic" };
  await renderCollapsedPage(fakeFacade({ list: async () => [copyItem, linkItem, sharedFirst, sharedSecond] }));
  await screen.findByRole("heading", { name: "待处理工作台" });

  // 同目标两种接入方式归并为一张卡；共享目录成员归并为一张共享目录卡。
  const toggles = screen.getAllByRole("button", { name: /查看事项明细/ });
  const labels = toggles.map((toggle) => toggle.getAttribute("aria-label"));
  expect(toggles).toHaveLength(2);
  expect(labels).toContain("查看事项明细: CodeBuddy");
  expect(labels).toContain("查看事项明细: Agent共享目录");
  // 品牌 logo 与用户可理解的展示类型徽标：CodeBuddy + 终端。
  expect(screen.getByLabelText("CodeBuddy · 终端")).toBeInTheDocument();
  // 共享目录卡去重品牌并标注各自展示类型，不出重复品牌卡。
  expect(screen.getByLabelText("Agent共享目录；Claude · 终端；OpenAI · 桌面端")).toBeInTheDocument();
  const sharedGroup = toggles[labels.indexOf("查看事项明细: Agent共享目录")]!.closest("li") as HTMLElement;
  expect(within(sharedGroup).getByText("2 项待办")).toBeVisible();
  const openAiLogos = sharedGroup.querySelectorAll('img[src$="openai.svg"]');
  const claudeLogos = sharedGroup.querySelectorAll('img[src$="anthropic.svg"]');
  expect(openAiLogos).toHaveLength(1);
  expect(claudeLogos).toHaveLength(1);
  // 技术目标标识不出现在任何正文或无障碍名称中。
  expect(screen.queryByText("target-a")).not.toBeInTheDocument();
  expect(screen.queryByText(/shared-1/)).not.toBeInTheDocument();

  const codeBuddyToggle = toggles[labels.indexOf("查看事项明细: CodeBuddy")]!;
  fireEvent.click(codeBuddyToggle);
  const firstGroup = codeBuddyToggle.closest("li") as HTMLElement;
  expect(within(firstGroup).getByText("复制导入")).toBeVisible();
  expect(within(firstGroup).getByText("链接导入（符号链接）")).toBeVisible();
});

it("does not offer a generic delete action for pending work", async () => {
  await renderPage(fakeFacade({
    list: async () => [{ id: "trial", subject: "skill-a", displayName: "skill-a", kind: "trial_due", code: "trial", message: "trial" }],
  }));
  await screen.findByText("skill-a");
  expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
});

it("filters pending work by its actual kind", async () => {
  await renderPage(fakeFacade({
    list: async () => [
      { id: "trial", subject: "skill-a", displayName: "skill-a", kind: "trial_due", code: "trial", message: "trial" },
      { id: "recovery", subject: "未完成部署", displayName: "未完成部署", kind: "recovery", code: "recovery", message: "recovery" },
    ],
  }));
  await screen.findByText("skill-a");

  fireEvent.change(screen.getByLabelText("具体事项"), { target: { value: "recovery" } });

  expect(screen.getByText("未完成部署")).toBeInTheDocument();
  expect(screen.queryByText("skill-a")).not.toBeInTheDocument();
});

it("prevents duplicate pending actions while one item is being processed", async () => {
  let release: (() => void) | undefined;
  const convert = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  await renderPage(fakeFacade({
    list: async () => [{ id: "trial", subject: "skill-a", displayName: "skill-a", kind: "trial_due", code: "trial", message: "trial" }],
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
  const riskBadge = screen.getAllByText("高风险")[0]!;
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
    list: async () => [optionalItem],
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
    [expect.objectContaining({ id: "work:ai_setup:settings:first" })],
    expect.stringMatching(/\S/),
  );
});

it("defers every selected item from the batch bar with visible progress", async () => {
  const gates: Array<() => void> = [];
  const defer = vi.fn((_items: PendingItem[], _days: number, _reason: string) => new Promise<void>((resolve) => { gates.push(resolve); }));
  await renderPage(fakeFacade({
    list: async () => [trialItem, optionalItem],
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
  expect(deferredIds).toEqual(["trial_due:skill-a:trial", "work:ai_setup:settings:first"]);
  for (const call of defer.mock.calls) {
    expect(call[1]).toBe(7);
    expect(String(call[2]).trim()).not.toBe("");
  }
});

it("requires confirmation before batch permanent ignore and does nothing on cancel", async () => {
  const ignore = vi.fn(async (_items: PendingItem[], _reason: string) => undefined);
  await renderPage(fakeFacade({
    list: async () => [trialItem, optionalItem],
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
  expect(ignoredIds).toEqual(["trial_due:skill-a:trial", "work:ai_setup:settings:first"]);
});

it("renders handled history and undoes an entry", async () => {
  const listHandled = vi.fn(async () => [
    { id: "rule-1", pendingId: "trial_due:skill-a:trial", reason: "暂缓 7 天后再提醒", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: "2026-09-08" },
  ]);
  const unignore = vi.fn(async () => undefined);
  await renderPage(fakeFacade({ listHandled, unignore }));

  await screen.findByText("处理历史");
  await screen.findByText("待办提醒记录");
  expect(screen.queryByText("trial_due:skill-a:trial")).not.toBeInTheDocument();
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
      { id: "recovery:op-2:recovery", subject: "未完成部署", displayName: "未完成部署", kind: "recovery", code: "recovery", message: "recovery" },
    ],
    loadSavedView,
    saveSavedView,
  }));

  await screen.findByText("未完成部署");
  await act(async () => {});
  expect(loadSavedView).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText("skill-a")).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: /^全部\s+\d+$/ }));
  await act(async () => {});
  await waitFor(() => expect(saveSavedView).toHaveBeenCalledWith("all"));
  expandPendingGroups();
  expect(screen.getByText("skill-a")).toBeInTheDocument();
});

it("keeps a safety finding in its workbench and never offers overview ignore", async () => {
  await renderPage(fakeFacade({ list: async () => [findingItem] }));
  await screen.findByText("skill-b");

  const group = screen.getByRole("group", { name: "处理 skill-b 的建议操作" });
  expect(within(group).getByRole("link", { name: "去处理" })).toHaveAttribute("href", "/library/skill-b/security?finding=finding-7");
  expect(within(group).queryByRole("button", { name: "暂缓" })).not.toBeInTheDocument();
  expect(within(group).queryByRole("button", { name: "忽略" })).not.toBeInTheDocument();
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
  await renderPage(fakeFacade({ list: async () => [trialItem, optionalItem] }));
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
    <MemoryRouter><I18nextProvider i18n={i18n}>
      <AppNotificationsProvider><PendingPage facade={facade} tracker={tracker} /></AppNotificationsProvider>
    </I18nextProvider></MemoryRouter>,
  );
  await act(async () => {});
  expandPendingGroups();
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
  const tracker = await renderBridgedPage(fakeFacade({ list: async () => [trialItem, optionalItem], defer }));
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
  let firstDeferred = false;
  const defer = vi.fn(async (_items: PendingItem[], _days: number, _reason: string) => {
    if (defer.mock.calls.length === 2) throw { code: "io.denied" };
    firstDeferred = true;
  });
  const list = vi.fn(async () => firstDeferred ? [optionalItem] : [trialItem, optionalItem]);
  const listHandled = vi.fn(async () => []);
  const tracker = await renderBridgedPage(fakeFacade({ list, defer, listHandled }));
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
  await waitFor(() => expect(listHandled).toHaveBeenCalledTimes(2));
  // 首错即停：第二项失败后不再继续，但已完成的第一项保留（刷新反映真实进度）。
  expect(defer).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByText("skill-a")).not.toBeInTheDocument());
  expect(screen.getByText("skill-b")).toBeVisible();
});

it("notifies a successful handled-entry undo through the bridge", async () => {
  const listHandled = vi.fn(async () => [
    { id: "rule-1", pendingId: "trial_due:skill-a:trial", reason: "暂缓 7 天后再提醒", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: "2026-09-08" },
  ]);
  const unignore = vi.fn(async () => undefined);
  await renderBridgedPage(fakeFacade({ listHandled, unignore }));
  await screen.findByText("待办提醒记录");

  fireEvent.click(screen.getByRole("button", { name: "撤销" }));

  const toast = await screen.findByTestId("notice-success");
  expect(toast).toHaveTextContent("撤销");
  await waitFor(() => expect(listHandled).toHaveBeenCalledTimes(2));
});

it("routes relationship follow-up to its workbench without confirming it on the overview", async () => {
  const item: PendingItem = { id: "work:followup:task", subject: "task", displayName: "Import reminder", kind: "governance_followup", code: "followup", message: "pending.reasons.governance_followup", canConfirm: true };
  const confirm = vi.fn(async () => undefined);
  const resolve = vi.fn(async () => undefined);
  await renderBridgedPage(fakeFacade({
    list: async () => [item, findingItem], confirm, resolve,
  }));
  expect([...screen.getAllByRole("link", { name: "去处理" })].map((link) => link.getAttribute("href"))).toContain("/discovery/local?task=task");
  expect(screen.getByText("skill-b")).toBeVisible();
  expect(confirm).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});
