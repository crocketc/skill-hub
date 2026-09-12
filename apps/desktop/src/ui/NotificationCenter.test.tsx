import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../i18n";
import {
  NOTICE_AUTO_DISMISS_MS,
  NotificationCenter,
  useNotices,
} from "./NotificationCenter";

function NoticeHarness({
  onReady,
}: {
  onReady?: (controls: { push: ReturnType<typeof useNotices>["pushNotice"] }) => void;
}) {
  const { dismissNotice, notices, pushNotice } = useNotices();
  onReady?.({ push: pushNotice });
  return <NotificationCenter notices={notices} onDismiss={dismissNotice} />;
}

describe("NotificationCenter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses success notices after the constant delay and keeps them dismissible", async () => {
    vi.useFakeTimers();
    let push: ReturnType<typeof useNotices>["pushNotice"] | undefined;
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <NoticeHarness
          onReady={(controls) => {
            push = controls.push;
          }}
        />
      </I18nextProvider>,
    );

    act(() => {
      push?.({ tone: "success", message: "Tags were saved" });
    });
    const region = screen.getByRole("region", { name: "Notifications" });
    const notice = withinNotice(region, "Tags were saved");
    // 成功通知：status + polite，可手动关闭。
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("aria-live", "polite");
    fireEvent.click(within(notice).getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Tags were saved")).not.toBeInTheDocument();

    act(() => {
      push?.({ tone: "success", message: "Saved again" });
    });
    act(() => {
      vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS - 1);
    });
    expect(screen.getByText("Saved again")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved again")).not.toBeInTheDocument();
  });

  it("keeps danger notices until the user closes them", async () => {
    vi.useFakeTimers();
    let push: ReturnType<typeof useNotices>["pushNotice"] | undefined;
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <NoticeHarness
          onReady={(controls) => {
            push = controls.push;
          }}
        />
      </I18nextProvider>,
    );

    act(() => {
      push?.({ tone: "danger", message: "Could not save tags" });
    });
    const region = screen.getByRole("region", { name: "Notifications" });
    const notice = withinNotice(region, "Could not save tags");
    // 危险通知：alert 语义，不自动消退。
    expect(notice).toHaveAttribute("role", "alert");
    act(() => {
      vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 10);
    });
    expect(screen.getByText("Could not save tags")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Could not save tags")).not.toBeInTheDocument();
  });

  it("keeps forced-persistent notices even when the tone is success", async () => {
    vi.useFakeTimers();
    let push: ReturnType<typeof useNotices>["pushNotice"] | undefined;
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <NoticeHarness
          onReady={(controls) => {
            push = controls.push;
          }}
        />
      </I18nextProvider>,
    );

    // 批量删除等危险操作结果：即使全部成功也必须常驻。
    act(() => {
      push?.({ message: "2 skills deleted", persistent: true, tone: "success" });
    });
    act(() => {
      vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 10);
    });
    expect(screen.getByText("2 skills deleted")).toBeVisible();
  });

  it("renders an optional detail node inside the notice", async () => {
    let push: ReturnType<typeof useNotices>["pushNotice"] | undefined;
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <NoticeHarness
          onReady={(controls) => {
            push = controls.push;
          }}
        />
      </I18nextProvider>,
    );

    act(() => {
      push?.({
        detail: <p>1 succeeded, 1 failed</p>,
        message: "Batch tag update",
        persistent: true,
        tone: "danger",
      });
    });
    expect(screen.getByText("Batch tag update")).toBeVisible();
    expect(screen.getByText("1 succeeded, 1 failed")).toBeVisible();
  });
});

function withinNotice(region: HTMLElement, text: string): HTMLElement {
  const notice = Array.from(region.querySelectorAll(".sh-notification")).find(
    (element) => element.textContent?.includes(text),
  );
  if (!(notice instanceof HTMLElement)) {
    throw new Error(`Expected a notice containing ${text}`);
  }
  return notice;
}

describe("NotificationCenter focus return", () => {
  it("returns focus to the host that preceded the close button after dismissal", async () => {
    let push: ReturnType<typeof useNotices>["pushNotice"] | undefined;
    const i18n = await createSkillHubI18n(["en-US"]);
    function Harness() {
      const controls = useNotices();
      push = controls.pushNotice;
      return (
        <>
          <button data-testid="host" type="button">
            Library filter
          </button>
          <NotificationCenter
            notices={controls.notices}
            onDismiss={controls.dismissNotice}
          />
        </>
      );
    }
    render(
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>,
    );

    act(() => {
      push?.({ tone: "danger", message: "Tags failed to save", persistent: true });
    });
    const host = screen.getByTestId("host");
    host.focus();
    const closeButton = screen.getByRole("button", { name: "Close" });
    // 模拟键盘 Tab 进入关闭按钮：焦点真实落在按钮上，且带 prior-host 的
    // focus 事件（relatedTarget）。关闭卸载按钮后，焦点必须回到宿主而非 body。
    closeButton.focus();
    fireEvent.focus(closeButton, { relatedTarget: host });
    fireEvent.click(closeButton);

    expect(screen.queryByText("Tags failed to save")).not.toBeInTheDocument();
    expect(host).toHaveFocus();
  });
});
