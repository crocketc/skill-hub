import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../i18n";
import type { WindowChrome } from "../platform/windowChrome";
import { WindowControls } from "./WindowControls";

const resolveWindowChrome = vi.hoisted(() => vi.fn());

vi.mock("../platform/windowChrome", () => ({
  resolveWindowChrome,
}));

interface ChromeHarness {
  chrome: WindowChrome;
  listeners: Set<(maximized: boolean) => void>;
  unlisten: ReturnType<typeof vi.fn>;
  emitMaximizeChange: (maximized: boolean) => void;
}

function createChromeHarness(
  initialMaximized = false,
): ChromeHarness {
  const listeners = new Set<(maximized: boolean) => void>();
  const unlisten = vi.fn();
  const chrome: WindowChrome = {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => initialMaximized),
    onMaximizeChange: vi.fn(async (listener) => {
      listeners.add(listener);
      return unlisten;
    }),
  };
  return {
    chrome,
    listeners,
    unlisten,
    emitMaximizeChange: (maximized: boolean) => {
      for (const listener of listeners) {
        listener(maximized);
      }
    },
  };
}

async function renderControls(harness: ChromeHarness) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const view = render(
    <I18nextProvider i18n={i18n}>
      <WindowControls />
    </I18nextProvider>,
  );
  // 初始 isMaximized 查询是异步的：等待订阅建立后再断言。
  await waitFor(() => expect(harness.chrome.onMaximizeChange).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  resolveWindowChrome.mockReset();
});

describe("WindowControls", () => {
  it("renders nothing when no window chrome is available", async () => {
    resolveWindowChrome.mockReturnValue(null);
    const i18n = await createSkillHubI18n(["en-US"]);
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <WindowControls />
      </I18nextProvider>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders minimize, maximize and close buttons as type=button with i18n aria labels", async () => {
    const harness = createChromeHarness();
    resolveWindowChrome.mockReturnValue(harness.chrome);
    await renderControls(harness);

    for (const name of ["Minimize", "Maximize", "Close"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("type", "button");
    }
    expect(harness.chrome.isMaximized).toHaveBeenCalled();
    expect(harness.chrome.onMaximizeChange).toHaveBeenCalledTimes(1);
  });

  it("invokes the matching window chrome action on click", async () => {
    const harness = createChromeHarness();
    resolveWindowChrome.mockReturnValue(harness.chrome);
    await renderControls(harness);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
      fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });

    expect(harness.chrome.minimize).toHaveBeenCalledTimes(1);
    expect(harness.chrome.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(harness.chrome.close).toHaveBeenCalledTimes(1);
  });

  it("switches to Restore when the window starts out maximized and still toggles", async () => {
    const harness = createChromeHarness(true);
    resolveWindowChrome.mockReturnValue(harness.chrome);
    await renderControls(harness);

    const restore = await screen.findByRole("button", { name: "Restore" });
    expect(
      screen.queryByRole("button", { name: "Maximize" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(restore);
    });
    expect(harness.chrome.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("updates the restore label from the maximize change listener", async () => {
    const harness = createChromeHarness(false);
    resolveWindowChrome.mockReturnValue(harness.chrome);
    await renderControls(harness);
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();

    act(() => {
      harness.emitMaximizeChange(true);
    });
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();

    act(() => {
      harness.emitMaximizeChange(false);
    });
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
  });

  it("unsubscribes the maximize listener on unmount", async () => {
    const harness = createChromeHarness();
    resolveWindowChrome.mockReturnValue(harness.chrome);
    const { unmount } = await renderControls(harness);

    unmount();

    expect(harness.unlisten).toHaveBeenCalledTimes(1);
  });
});
