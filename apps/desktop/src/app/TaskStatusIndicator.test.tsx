import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../i18n";
import { createOperationTracker } from "../platform/operationTracker";
import { TaskStatusIndicator } from "./TaskStatusIndicator";

it("surfaces a batch import's real progress in the global task details", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const tracker = createOperationTracker();
  const operationId = tracker.begin({ kind: "import", label: "批量导入 Skill", total: 42 });
  tracker.progress(operationId, 1);

  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <TaskStatusIndicator tracker={tracker} />
      </I18nextProvider>
    </MemoryRouter>,
  );

  expect(screen.getByRole("status", { name: "批量导入 Skill：进行中（1/42）" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "批量导入 Skill：进行中（1/42）" }));
  expect(await screen.findByRole("dialog", { name: "任务详情" })).toHaveTextContent("1/42");
});
