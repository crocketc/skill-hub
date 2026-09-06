import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../i18n";
import { createOperationTracker } from "../platform/operationTracker";
import { OperationIndicator } from "./OperationIndicator";

async function renderIndicator(tracker: ReturnType<typeof createOperationTracker>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <OperationIndicator tracker={tracker} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

it("renders nothing without tracked operations", async () => {
  const tracker = createOperationTracker();
  const { container } = await renderIndicator(tracker);
  expect(container).toBeEmptyDOMElement();
});

it("shows running progress and completed results with an operations link", async () => {
  const tracker = createOperationTracker();
  const id = tracker.begin({ kind: "import", label: "导入 2 个 Skill", total: 2 });
  tracker.progress(id, 1, 2);
  await renderIndicator(tracker);

  expect(screen.getByRole("status")).toHaveTextContent("导入 2 个 Skill");
  expect(screen.getByRole("status")).toHaveTextContent("1/2");

  await act(async () => {
    tracker.complete(id, { succeeded: 1, failed: 1, skipped: 0 });
  });
  const completed = screen.getByRole("status");
  expect(completed).toHaveTextContent("成功 1");
  expect(completed).toHaveTextContent("失败 1");
  expect(screen.getByRole("link", { name: "查看操作记录" })).toHaveAttribute("href", "/operations");
});

it("surfaces failed operations with their error", async () => {
  const tracker = createOperationTracker();
  const id = tracker.begin({ kind: "import", label: "导入", total: 1 });
  tracker.fail(id, "磁盘已满");
  await renderIndicator(tracker);

  expect(screen.getByRole("alert")).toHaveTextContent("磁盘已满");
});

it("offers a close button for finished and failed rows and hides the row on click", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const tracker = createOperationTracker();
  const okId = tracker.begin({ kind: "import", label: "完成导入", total: 1 });
  tracker.complete(okId, { succeeded: 1, failed: 0, skipped: 0 });
  const badId = tracker.begin({ kind: "import", label: "失败导入", total: 1 });
  tracker.fail(badId, "boom");

  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <OperationIndicator tracker={tracker} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(screen.getByText(/完成导入 已完成/)).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("boom");

  const completedRow = screen.getByText(/完成导入 已完成/).closest("p") as HTMLElement;
  await act(async () => {
    fireEvent.click(within(completedRow).getByRole("button", { name: "关闭" }));
  });
  expect(screen.queryByText(/完成导入 已完成/)).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("boom");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText(/失败导入 失败/)).not.toBeInTheDocument();
});

it("auto-dismisses completed rows after ten seconds while failed rows persist", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const tracker = createOperationTracker();
  const okId = tracker.begin({ kind: "import", label: "完成导入", total: 1 });
  tracker.complete(okId, { succeeded: 1, failed: 0, skipped: 0 });
  const badId = tracker.begin({ kind: "import", label: "失败导入", total: 1 });
  tracker.fail(badId, "磁盘已满");

  vi.useFakeTimers();
  try {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <OperationIndicator tracker={tracker} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByText(/完成导入 已完成/)).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.queryByText(/完成导入 已完成/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("磁盘已满");
  } finally {
    vi.useRealTimers();
  }
});
