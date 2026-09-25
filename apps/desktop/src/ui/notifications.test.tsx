import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { Link, MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { createSkillHubI18n } from "../i18n";
import { createOperationTracker } from "../platform/operationTracker";
import { runTrackedOperation } from "../platform/runTrackedOperation";
import { OperationsList } from "../features/operations/OperationsList";
import {
  AppNotificationsProvider,
  type AppNotifications,
  NOTICE_TOAST_DURATION_MS,
  NOTICE_TOAST_EXIT_MS,
  NotificationBell,
  useAppNotifications,
  type AppNotice,
} from "./notifications";
import { stubMatchMediaReducedMotion } from "./testMatchMedia";
import notificationCss from "./notificationCenter.css?raw";

interface HarnessHandles {
  notify: (notice: AppNotice) => string;
  dismiss: (id: string) => void;
  noticeCount: () => number;
  unreadCount: () => number;
  service: AppNotifications;
}

const handles: { current: HarnessHandles | null } = { current: null };

function Capture() {
  const controls = useAppNotifications();
  handles.current = {
    notify: controls.notify,
    dismiss: controls.dismiss,
    noticeCount: () => controls.notices.length,
    unreadCount: () => controls.unreadCount,
    service: controls,
  };
  return (
    <nav>
      <Link to="/library">to library</Link>
      <NotificationBell />
    </nav>
  );
}

function LocationProbe() {
  const { pathname } = useLocation();
  return <p>page@{pathname}</p>;
}

/** 持久化操作记录探针：数据只来自 RecentOperationsReader（后端事实），
 * 与会话通知 store 完全无关——“清除通知”不得影响这里。 */
function OperationRecordProbe({ operationId }: { operationId: string }) {
  return (
    <OperationsList
      recent={{
        listRecentOperations: async () => [
          {
            operation_id: operationId,
            kind: "commit_deployment",
            state: "committed",
            phase: "committed" as const,
            error_code: null,
            created_at: "2026-09-16T00:00:00Z",
          },
        ],
      }}
      tracker={createOperationTracker()}
    />
  );
}

async function renderNotificationShell(initialEntries = ["/"], withRecordRoute = false) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={initialEntries}>
        <AppNotificationsProvider>
          <Capture />
          <Routes>
            <Route element={<LocationProbe />}>
              <Route path="/" element={<p>overview body</p>} />
              <Route path="/library" element={<p>library body</p>} />
            </Route>
            {withRecordRoute ? (
              <Route path="/operations/:operationId" element={<RecordRoute />} />
            ) : null}
          </Routes>
        </AppNotificationsProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function RecordRoute() {
  const { operationId } = useParams();
  return (
    <>
      <p>page@/operations/{operationId}</p>
      <OperationRecordProbe operationId={operationId ?? "unknown"} />
    </>
  );
}

function toastRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Notifications" });
}

function toastTitles(region: HTMLElement): string[] {
  return [...region.querySelectorAll("[data-toast-title]")].map(
    (element) => element.textContent ?? "",
  );
}

async function openHistoryDrawer() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Notifications/ }));
  return screen.getByRole("dialog", { name: "Notifications" });
}

describe("AppNotificationsProvider toasts", () => {
  afterEach(() => {
    vi.useRealTimers();
    handles.current = null;
  });

  it("uses the shared toast placement on detail routes with the normal topbar", async () => {
    await renderNotificationShell(["/library/skill-pdf"]);

    act(() => {
      handles.current?.notify({ tone: "danger", title: "Delete failed" });
    });

    expect(toastRegion()).not.toHaveClass("is-detail-route");
    expect(notificationCss).not.toContain(".sh-notification-center.is-detail-route");
  });

  it("shows a toast in a top-right stack region and removes it after the 2s duration", async () => {
    vi.useFakeTimers();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "Tags were saved" });
    });

    const region = toastRegion();
    expect(toastTitles(region)).toEqual(["Tags were saved"]);
    const toast = within(region).getByRole("status");
    expect(toast).toHaveAttribute("aria-live", "polite");

    act(() => {
      vi.advanceTimersByTime(NOTICE_TOAST_DURATION_MS - 1);
    });
    expect(within(toastRegion()).getByRole("status")).toBeVisible();

    // 展示时长结束：先进入滑出阶段，动画结束后从 DOM 移除。
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(within(toastRegion()).getByRole("status")).toHaveAttribute(
      "data-state",
      "exiting",
    );

    act(() => {
      vi.advanceTimersByTime(NOTICE_TOAST_EXIT_MS);
    });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("auto-dismisses every tone after the same duration, including danger alerts", async () => {
    vi.useFakeTimers();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "saved" });
      handles.current?.notify({ tone: "info", title: "sync running" });
      handles.current?.notify({ tone: "warning", title: "source drifted" });
      handles.current?.notify({ tone: "danger", title: "deployment failed" });
    });

    const region = toastRegion();
    expect(within(region).getByRole("alert")).toHaveTextContent("deployment failed");
    // 最新的通知在栈顶。
    expect(toastTitles(region)).toEqual([
      "deployment failed",
      "source drifted",
      "sync running",
      "saved",
    ]);

    act(() => {
      vi.advanceTimersByTime(NOTICE_TOAST_DURATION_MS + NOTICE_TOAST_EXIT_MS);
    });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("keeps expired toasts in the session history so errors outlive the toast", async () => {
    vi.useFakeTimers();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({
        tone: "danger",
        title: "deployment failed",
        detail: "agent write protected",
      });
    });
    act(() => {
      vi.advanceTimersByTime(NOTICE_TOAST_DURATION_MS + NOTICE_TOAST_EXIT_MS);
    });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    expect(handles.current?.noticeCount()).toBe(1);

    // 计时断言结束后恢复真实时钟，抽屉交互不需要 fake timers。
    vi.useRealTimers();
    const drawer = await openHistoryDrawer();
    expect(within(drawer).getByText("deployment failed")).toBeVisible();
    expect(within(drawer).getByText("agent write protected")).toBeVisible();
  });

  it("closes a toast through its close button and the remaining message moves up the stack", async () => {
    vi.useFakeTimers();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "first" });
      handles.current?.notify({ tone: "success", title: "second" });
    });

    expect(toastTitles(toastRegion())).toEqual(["second", "first"]);

    // 关闭栈顶（最新）消息后，下一条上移补位，历史记录不受影响。
    const [topToast] = within(toastRegion()).getAllByRole("status");
    fireEvent.click(within(topToast).getByRole("button", { name: "Close" }));
    expect(toastTitles(toastRegion())).toEqual(["first"]);
    expect(handles.current?.noticeCount()).toBe(2);
  });

  it("navigates through a toast action link and closes the toast", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({
        tone: "info",
        title: "deployment finished",
        action: { label: "View operation", to: "/library" },
      });
    });

    await user.click(screen.getByRole("link", { name: "View operation" }));
    expect(screen.getByText("page@/library")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("keeps toasts and history alive across route navigation", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "import finished" });
    });
    await user.click(screen.getByRole("link", { name: "to library" }));

    expect(screen.getByText("page@/library")).toBeVisible();
    expect(toastTitles(toastRegion())).toEqual(["import finished"]);
    expect(handles.current?.noticeCount()).toBe(1);
  });

  it("renders toasts in the instant state when reduced motion is effective", async () => {
    vi.useFakeTimers();
    stubMatchMediaReducedMotion(true);
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "saved" });
    });

    expect(toastRegion()).toHaveAttribute("data-reduced-motion", "true");
    expect(toastTitles(toastRegion())).toEqual(["saved"]);

    // 状态仍可达：消退计时不受减少动效影响。
    act(() => {
      vi.advanceTimersByTime(NOTICE_TOAST_DURATION_MS);
    });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });
});

describe("NotificationBell and history drawer", () => {
  it("announces the unread count and clears it through mark-all-read", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell).toHaveAttribute("aria-label", "Notifications");

    act(() => {
      handles.current?.notify({ tone: "success", title: "first" });
      handles.current?.notify({ tone: "danger", title: "second" });
    });
    expect(screen.getByRole("button", { name: "Notifications, 2 unread" })).toBe(bell);

    await user.click(bell);
    const drawer = screen.getByRole("dialog", { name: "Notifications" });
    await user.click(within(drawer).getByRole("button", { name: "Mark all as read" }));

    expect(bell).toHaveAttribute("aria-label", "Notifications");
    expect(handles.current?.unreadCount()).toBe(0);
  });

  it("filters the history between unread and all entries", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "older entry" });
    });

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const drawer = screen.getByRole("dialog", { name: "Notifications" });
    // DEV-92：多条时默认折叠为层叠视图，筛选在展开态操作。
    await user.click(within(drawer).getByRole("button", { name: "View all" }));

    // 先把旧条目标为已读，再产生一条新通知，让未读筛选有可区分的集合。
    await user.click(within(drawer).getByRole("button", { name: "Mark all as read" }));
    act(() => {
      handles.current?.notify({ tone: "success", title: "unread entry" });
    });
    expect(within(drawer).getByText("unread entry")).toBeVisible();
    expect(within(drawer).getByText("older entry")).toBeVisible();

    await user.click(within(drawer).getByRole("button", { name: "Unread" }));
    expect(within(drawer).getByText("unread entry")).toBeVisible();
    expect(within(drawer).queryByText("older entry")).toBeNull();

    await user.click(within(drawer).getByRole("button", { name: "All" }));
    expect(within(drawer).getByText("older entry")).toBeVisible();
  });

  it("clears the whole history from the drawer", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "only entry" });
    });
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const drawer = screen.getByRole("dialog", { name: "Notifications" });
    await user.click(within(drawer).getByRole("button", { name: "Clear all" }));

    expect(handles.current?.noticeCount()).toBe(0);
    expect(within(drawer).getByText("No notifications yet.")).toBeVisible();
  });

  it("shows an empty history state when nothing was notified", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    const drawer = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(drawer).getByText("No notifications yet.")).toBeVisible();
  });

  it("keeps the bell keyboard operable and carrying the shared icon-button contract", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    const bell = screen.getByRole("button", { name: "Notifications" });
    // Skip link 先获得焦点，随后 bell 可经键盘到达。
    await user.tab();
    await user.tab();
    expect(bell).toHaveFocus();
    // ≥40×40 点击面积由共享 .sh-icon-button 契约保证。
    expect(bell).toHaveClass("sh-icon-button");
  });
});

describe("history drawer marks an entry read on activation", () => {
  it("marks the entry read and closes the drawer when the message body is clicked", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({
        tone: "danger",
        title: "deployment failed",
        detail: "agent write protected",
      });
    });
    expect(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeVisible();

    const drawer = await openHistoryDrawer();
    await user.click(
      within(drawer).getByRole("button", {
        name: 'Mark "deployment failed" as read',
      }),
    );

    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    // 角标随已读同步清零；历史保留，记录只标已读不删除。
    expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
    expect(handles.current?.unreadCount()).toBe(0);
    expect(handles.current?.noticeCount()).toBe(1);
  });

  it("marks the entry read before navigating through its action link", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({
        tone: "info",
        title: "deployment finished",
        action: { label: "View operation", to: "/library" },
      });
    });

    const drawer = await openHistoryDrawer();
    await user.click(within(drawer).getByRole("link", { name: "View operation" }));

    expect(screen.getByText("page@/library")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(handles.current?.unreadCount()).toBe(0);
    expect(handles.current?.noticeCount()).toBe(1);
  });

  it("activates the message body with Enter from keyboard focus", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "tags were saved" });
    });

    const drawer = await openHistoryDrawer();
    const body = within(drawer).getByRole("button", {
      name: 'Mark "tags were saved" as read',
    });
    body.focus();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(handles.current?.unreadCount()).toBe(0);
    expect(handles.current?.noticeCount()).toBe(1);
  });

  it("keeps repeated activation of the same entry read without errors", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({
        tone: "info",
        title: "import finished",
        action: { label: "View operation", to: "/library" },
      });
    });

    // 第一次：本体点击标记已读并关闭抽屉。
    const drawer = await openHistoryDrawer();
    await user.click(
      within(drawer).getByRole("button", { name: 'Mark "import finished" as read' }),
    );
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();

    // 第二次：本体重复激活不报错，状态保持已读。
    const reopened = await openHistoryDrawer();
    await user.click(
      within(reopened).getByRole("button", { name: 'Mark "import finished" as read' }),
    );
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();

    // 第三次：action 链接重复触发同样幂等。
    const again = await openHistoryDrawer();
    await user.click(within(again).getByRole("link", { name: "View operation" }));
    expect(handles.current?.unreadCount()).toBe(0);
    expect(handles.current?.noticeCount()).toBe(1);
  });

  it("drops the entry from the unread filter and decrements the badge after its body is clicked", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "success", title: "older entry" });
    });
    const drawer = await openHistoryDrawer();
    await user.click(within(drawer).getByRole("button", { name: "Mark all as read" }));
    act(() => {
      handles.current?.notify({ tone: "success", title: "unread entry" });
    });
    // DEV-92：先展开（筛选控件在展开态），再切未读筛选。
    await user.click(within(drawer).getByRole("button", { name: "View all" }));
    await user.click(within(drawer).getByRole("button", { name: "Unread" }));
    expect(within(drawer).getByText("unread entry")).toBeVisible();

    // 未读筛选下点击本体：先标记已读再关闭抽屉。
    await user.click(
      within(drawer).getByRole("button", { name: 'Mark "unread entry" as read' }),
    );
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();

    // 重新打开：浮层回到折叠态；展开并切到“未读”后，该条已从未读列表
    // 消失，仅剩空态提示（筛选不跨开关持久是 DEV-92 的既定行为）。
    const reopened = await openHistoryDrawer();
    await user.click(within(reopened).getByRole("button", { name: "View all" }));
    await user.click(within(reopened).getByRole("button", { name: "Unread" }));
    expect(within(reopened).getByText("No unread notifications.")).toBeVisible();
    // 切回“全部”：两条历史都保留且均已读。
    await user.click(within(reopened).getByRole("button", { name: "All" }));
    expect(within(reopened).getByText("older entry")).toBeVisible();
    expect(within(reopened).getByText("unread entry")).toBeVisible();
    expect(handles.current?.unreadCount()).toBe(0);
    expect(handles.current?.noticeCount()).toBe(2);
  });
});

describe("provider cleanup", () => {
  it("stops toasting after the provider unmounts even if timers were pending", async () => {
    vi.useFakeTimers();
    const i18n = await createSkillHubI18n(["en-US"]);
    const { unmount } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/"]}>
          <AppNotificationsProvider>
            <Capture />
          </AppNotificationsProvider>
        </MemoryRouter>
      </I18nextProvider>,
    );

    act(() => {
      handles.current?.notify({ tone: "success", title: "bye" });
    });
    unmount();

    act(() => {
      vi.advanceTimersByTime(NOTICE_TOAST_DURATION_MS * 2);
    });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });
});

describe("toast close button hit area", () => {
  /** 从注入的样式表中取回指定选择器的规则（精确匹配逗号分隔的任一段）。 */
  function ruleFor(selector: string): CSSStyleRule | undefined {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (
          rule instanceof CSSStyleRule &&
          rule.selectorText
            ?.split(",")
            .map((part) => part.trim())
            .includes(selector)
        ) {
          return rule;
        }
      }
    }
    return undefined;
  }

  it("keeps the close control at a 40px square despite the small button variant", () => {
    // 计划约束"全部图标按钮至少 40×40"：关闭按钮虽然复用 Button size="sm"
    // （min-height 2rem=32px），但 toast 专属类必须覆盖出 40×40 命中区。
    const rule = ruleFor(".sh-notification__close");
    expect(rule, ".sh-notification__close is defined in notificationCenter.css").toBeDefined();
    expect(rule!.style.getPropertyValue("width")).toBe("2.5rem");
    expect(rule!.style.getPropertyValue("height")).toBe("2.5rem");
    expect(rule!.style.getPropertyValue("min-width")).toBe("2.5rem");
    expect(rule!.style.getPropertyValue("min-height")).toBe("2.5rem");
    // 抵消 .sh-button--sm 的水平内边距，保证恰好 40×40 的正方形命中区。
    expect(rule!.style.getPropertyValue("padding")).toBe("0");
  });
});

/** 统一执行桥在通知壳内的真实产物：成功/部分失败/失败/需人工确认四类
 *  通知都必须深链到同一 operation id 的操作记录页。 */
async function runBridged(noticeKind: "success" | "partial" | "failed" | "needs_user", operationId: string) {
  const pending = runTrackedOperation({
    notifications: handles.current?.service ?? null,
    kind: "deploy",
    label: "Added to Agent",
    translate: (key) => key,
    successNotice: (result) => {
      const outcome = result as { outcome: "success" | "partial" };
      return outcome.outcome === "partial"
        ? { tone: "warning", title: "Added to Agent, some targets failed" }
        : { tone: "success", title: "Added to Agent" };
    },
    run: async (handle) => {
      handle.correlate(operationId);
      if (noticeKind === "needs_user") {
        handle.needsUser("recovery.confirmRequired");
        // 阻塞在用户动作上：只有 needs_user 通知，没有后续结果通知。
        await new Promise<void>(() => undefined);
      }
      if (noticeKind === "failed") {
        throw new Error("agent write protected");
      }
      return { outcome: noticeKind };
    },
    summarize: (result) => {
      const outcome = (result as { outcome: "success" | "partial" }).outcome;
      return outcome === "partial"
        ? { succeeded: 1, failed: 1, skipped: 0 }
        : { succeeded: 1, failed: 0, skipped: 0 };
    },
  }).catch(() => undefined);
  if (noticeKind === "needs_user") {
    // 阻塞型运行不等待结束：needs_user 通知在阻塞时即已发出。
    await Promise.resolve();
    await Promise.resolve();
    return;
  }
  await pending;
}

describe("operation notices deep link to the operation record", () => {
  // 前面的 provider cleanup 用例装了 fake timers 未恢复；本组全部是
  // 真实时钟的异步交互，进来先恢复，避免微任务被假时钟卡死。
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    handles.current = null;
  });

  it.each([
    { kind: "success" as const, operationId: "op-101", tone: "success" },
    { kind: "partial" as const, operationId: "op-102", tone: "warning" },
    { kind: "failed" as const, operationId: "op-103", tone: "danger" },
    { kind: "needs_user" as const, operationId: "op-104", tone: "info" },
  ])("deep links the $kind notice to /operations and clears the toast", async ({ kind, operationId, tone }) => {
    const user = userEvent.setup();
    await renderNotificationShell(["/"], true);

    // 桥在 React 事件外跑：通知写入需在 act 内落盘。
    await act(async () => {
      await runBridged(kind, operationId);
    });

    const region = screen.getByRole("region", { name: "Notifications" });
    const toast = within(region).getByTestId(`notice-${tone}`);
    await user.click(within(toast).getByRole("link", { name: "tasks.notices.viewRecord" }));

    // 深链落在该 operation id 的操作记录页（持久化事实，非会话通知）。
    expect(screen.getByRole("link", { name: "commit_deployment" })).toBeVisible();
    expect(screen.getByText(`page@/operations/${operationId}`)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("keeps the backend operation record reachable after the session notices are cleared", async () => {
    const user = userEvent.setup();
    // 直接落在操作记录页：记录内容来自 RecentOperationsReader（后端事实）。
    await renderNotificationShell(["/operations/op-105"], true);
    expect(await screen.findByRole("link", { name: "commit_deployment" })).toBeVisible();

    await act(async () => {
      await runBridged("success", "op-105");
    });
    expect(handles.current?.noticeCount()).toBe(1);

    // 清空会话通知后，后端操作记录仍然在场——清除不是删除。
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const drawer = screen.getByRole("dialog", { name: "Notifications" });
    await user.click(within(drawer).getByRole("button", { name: "Clear all" }));
    expect(handles.current?.noticeCount()).toBe(0);
    // 抽屉是模态的，先关闭再回看背后的操作记录页。
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("link", { name: "commit_deployment" })).toBeVisible();
  });
});

describe("DEV-92 notification popover", () => {
  it("stacks collapsed history: latest card visible, older entries behind edges", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      // 通知按时间倒序展示：最后通知的「newest」位于栈顶。
      handles.current?.notify({ tone: "warning", title: "oldest", source: "library" });
      handles.current?.notify({ tone: "info", title: "middle", source: "library" });
      handles.current?.notify({ tone: "success", title: "newest", source: "library" });
    });

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const popover = screen.getByRole("dialog", { name: "Notifications" });

    // 最新一条完整展示；层叠上缘至多两条；旧条目标题不直接出现。
    expect(within(popover).getByText("newest")).toBeVisible();
    expect(within(popover).getAllByTestId("notification-stack-edge")).toHaveLength(2);
    expect(within(popover).queryByText("older entry")).toBeNull();
    expect(within(popover).queryByText("middle")).toBeNull();

    // 展开切换：View all 展示全量；Collapse 回到层叠。
    await user.click(within(popover).getByRole("button", { name: "View all" }));
    expect(within(popover).getByText("middle")).toBeVisible();
    expect(within(popover).getByText("oldest")).toBeVisible();
    await user.click(within(popover).getByRole("button", { name: "Collapse" }));
    expect(within(popover).getByText("newest")).toBeVisible();
    expect(within(popover).queryByText("middle")).toBeNull();
  });

  it("groups expanded history by functional domain with local labels", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({ tone: "info", title: "discovery fact", source: "discovery" });
      handles.current?.notify({ tone: "success", title: "library fact", source: "library" });
      handles.current?.notify({ tone: "danger", title: "no source" });
    });

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    await user.click(screen.getByRole("button", { name: "View all" }));
    const popover = screen.getByRole("dialog", { name: "Notifications" });

    expect(within(popover).getByText("Discovery")).toBeVisible();
    expect(within(popover).getByText("Skill library")).toBeVisible();
    // 缺省 source 归入 System 组。
    expect(within(popover).getByText("System")).toBeVisible();
  });

  it("renders per-entry times and keeps the read activation semantics in expanded view", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    act(() => {
      handles.current?.notify({
        tone: "danger",
        title: "timed entry",
        detail: "with detail",
        source: "deployment",
      });
    });

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const popover = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(popover).getByRole("time")).toBeVisible();

    // 折叠态本体点击：标已读并收起浮层（与旧抽屉语义一致）。
    await user.click(
      within(popover).getByRole("button", { name: 'Mark "timed entry" as read' }),
    );
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(handles.current?.unreadCount()).toBe(0);
  });

  it("animates the popover from the top-right and skips motion when reduced", async () => {
    const user = userEvent.setup();
    await renderNotificationShell();

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const popover = screen.getByRole("dialog", { name: "Notifications" });
    // 进入后处于 open 态；CSS 由 data-state 驱动右上角进出场（transform-origin
    // 与 closing 态由 CSS 契约测试锁定）。本壳层是减少动效环境：进入即 open。
    expect(popover).toHaveAttribute("data-state", "open");

    await user.click(within(popover).getByRole("button", { name: "Close" }));
    // 减少动效下关闭瞬时完成：浮层直接卸载。
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull(),
    );
  });

  it("keeps the popover CSS contract: blur, top-right origin, stack edges", () => {
    expect(notificationCss).toContain("backdrop-filter");
    expect(notificationCss).toContain("transform-origin: top right");
    expect(notificationCss).toContain(".sh-notification-popover__edge");
    expect(notificationCss).toContain('.sh-notification-popover[data-state="closing"]');
    expect(notificationCss).toContain('[data-reduced-motion="true"]');
  });
});
