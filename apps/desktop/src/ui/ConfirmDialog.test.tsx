import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog(onConfirm: () => void, props: { closeLabel?: string } = {}) {
  render(
    <ConfirmDialog
      cancelLabel="取消"
      closeLabel={props.closeLabel}
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

it("moves focus into the dialog when opened and keeps it trapped while tabbing", () => {
  const onConfirm = vi.fn();
  renderDialog(onConfirm);

  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toContainElement(document.activeElement as HTMLElement | null);

  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });

  expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
});

it("closes on Escape without running the operation and returns focus", async () => {
  const onConfirm = vi.fn();
  renderDialog(onConfirm);

  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

  await waitFor(() => {
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "移除技能" })).toHaveFocus();
});

it("offers a close action that cancels without running the operation", async () => {
  const onConfirm = vi.fn();
  renderDialog(onConfirm, { closeLabel: "关闭" });

  fireEvent.click(screen.getByRole("button", { name: "关闭" }));

  await waitFor(() => {
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  expect(onConfirm).not.toHaveBeenCalled();
});

it("keeps the dialog untouched by keyboard when no close label is provided", () => {
  const onConfirm = vi.fn();
  renderDialog(onConfirm);

  expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
});
