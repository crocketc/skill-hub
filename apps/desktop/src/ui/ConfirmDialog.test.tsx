import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog(onConfirm: () => void) {
  render(
    <ConfirmDialog
      cancelLabel="取消"
      confirmLabel="移除"
      description="集中库中的技能会保留。"
      onConfirm={onConfirm}
      title="从 Agent 移除？"
      trigger={<button type="button">移除技能</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "移除技能" }));
}

it("keeps the operation untouched when confirmation is cancelled", async () => {
  const onConfirm = vi.fn();
  renderDialog(onConfirm);

  fireEvent.click(screen.getByRole("button", { name: "取消" }));

  expect(onConfirm).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "移除技能" })).toHaveFocus();
  });
});

it("runs the operation only after the explicit confirmation action", () => {
  const onConfirm = vi.fn();
  renderDialog(onConfirm);

  expect(screen.getByRole("alertdialog", { name: "从 Agent 移除？" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "移除" }));

  expect(onConfirm).toHaveBeenCalledOnce();
});
