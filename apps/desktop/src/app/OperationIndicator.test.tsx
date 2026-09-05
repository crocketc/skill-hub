import { act, render, screen } from "@testing-library/react";
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
