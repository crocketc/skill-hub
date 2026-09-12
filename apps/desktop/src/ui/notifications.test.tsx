import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { createSkillHubI18n } from "../i18n";
import {
  AppNotificationsProvider,
  NOTICE_TOAST_DURATION_MS,
  NOTICE_TOAST_EXIT_MS,
  NotificationBell,
  useAppNotifications,
  type AppNotice,
} from "./notifications";
import { stubMatchMediaReducedMotion } from "./testMatchMedia";

interface HarnessHandles {
  notify: (notice: AppNotice) => string;
  dismiss: (id: string) => void;
  noticeCount: () => number;
  unreadCount: () => number;
}

const handles: { current: HarnessHandles | null } = { current: null };

function Capture() {
  const controls = useAppNotifications();
  handles.current = {
    notify: controls.notify,
    dismiss: controls.dismiss,
    noticeCount: () => controls.notices.length,
    unreadCount: () => controls.unreadCount,
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

async function renderNotificationShell() {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/"]}>
        <AppNotificationsProvider>
          <Capture />
          <Routes>
            <Route element={<LocationProbe />}>
              <Route path="/" element={<p>overview body</p>} />
              <Route path="/library" element={<p>library body</p>} />
            </Route>
          </Routes>
        </AppNotificationsProvider>
      </MemoryRouter>
    </I18nextProvider>,
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
