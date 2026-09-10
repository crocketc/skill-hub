import { act, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
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

it("wires each tab to its panel with aria-controls and roving tabindex", async () => {
  await renderPage();

  const records = screen.getByRole("tab", { name: "操作记录" });
  const backup = screen.getByRole("tab", { name: "备份恢复" });

  expect(records).toHaveAttribute("aria-controls", "recovery-panel-records");
  expect(backup).toHaveAttribute("aria-controls", "recovery-panel-backup");

  // 选中页签可 Tab 进入，未选中页签由方向键到达（roving tabindex）。
  expect(records).toHaveAttribute("tabindex", "0");
  expect(backup).toHaveAttribute("tabindex", "-1");

  await userEvent.setup().click(backup);
  expect(backup).toHaveAttribute("tabindex", "0");
  expect(records).toHaveAttribute("tabindex", "-1");
  expect(screen.getByRole("tabpanel", { name: "备份恢复" })).toHaveAttribute("id", "recovery-panel-backup");
});

it("moves selection and focus with the arrow keys and wraps at the ends", async () => {
  const user = userEvent.setup();
  await renderPage();

  const records = screen.getByRole("tab", { name: "操作记录" });
  const backup = screen.getByRole("tab", { name: "备份恢复" });

  await user.click(records);
  records.focus();

  fireEvent.keyDown(records, { key: "ArrowRight" });
  expect(backup).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(backup);

  // 从末尾向右循环回第一个页签。
  fireEvent.keyDown(backup, { key: "ArrowRight" });
  expect(records).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(records);

  // 从开头向左循环到最后一个页签。
  fireEvent.keyDown(records, { key: "ArrowLeft" });
  expect(backup).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(backup);

  fireEvent.keyDown(backup, { key: "Home" });
  expect(records).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(records);

  fireEvent.keyDown(records, { key: "End" });
  expect(backup).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(backup);
});
