import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { RecoveryPage } from "./RecoveryPage";
import type { OperationFacade, OperationState } from "../operations/api";

const operation: OperationState = {
  operationId: "op-recover",
  phase: "needs_recovery",
  completed: 0,
  total: 1,
  message: "deployment.target_conflict",
};

const facade: OperationFacade = {
  async get() {
    return operation;
  },
  async acknowledgeRecovery() {
    return;
  },
};

async function renderPage() {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <RecoveryPage facade={facade} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

it("defaults to the operation records tab", async () => {
  await renderPage();

  expect(await screen.findByRole("tab", { selected: true })).toHaveTextContent("操作记录");
  expect(screen.getByRole("tabpanel")).toBeVisible();
});

it("switches to the backup & restore tab and keeps the recovery confirmation there", async () => {
  const user = userEvent.setup();
  await renderPage();

  await user.click(screen.getByRole("tab", { name: "备份恢复" }));
  expect(screen.getByRole("tabpanel")).toHaveTextContent("deployment.target_conflict");
  expect(screen.getByRole("button", { name: "确认恢复" })).toBeVisible();
});

it("acknowledges recovery from the backup & restore tab", async () => {
  const user = userEvent.setup();
  await renderPage();

  await user.click(screen.getByRole("tab", { name: "备份恢复" }));
  await act(async () => {
    await user.click(screen.getByRole("button", { name: "确认恢复" }));
  });
  expect(screen.getByText("已回滚")).toBeVisible();
});
