import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { BatchTagDialog } from "./BatchTagDialog";

async function renderDialog(action: "add_tag" | "remove_tag", onConfirm = vi.fn()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <BatchTagDialog action={action} count={3} onCancel={() => undefined} onConfirm={onConfirm} />
    </I18nextProvider>,
  );
  return onConfirm;
}

it("removes tags only after a preview step naming the tags and the affected skills", async () => {
  const onConfirm = await renderDialog("remove_tag");

  fireEvent.change(screen.getByRole("textbox", { name: "标签" }), {
    target: { value: "待复核, 客户可见" },
  });
  fireEvent.click(screen.getByRole("button", { name: "移除标签" }));

  // 提交前轻量预览：列出将移除的标签与受影响 Skill 数，并固定说明保留物与恢复方式。
  expect(screen.getByRole("heading", { name: "确认移除这些标签？" })).toBeVisible();
  expect(screen.getByText("待复核")).toBeVisible();
  expect(screen.getByText("客户可见")).toBeVisible();
  expect(screen.getByText("将影响 3 个 Skill")).toBeVisible();
  expect(screen.getByText(/保留：Skill 本体、内容与部署完全不变。/)).toBeVisible();
  expect(screen.getByText(/恢复：重新添加同名标签即可/)).toBeVisible();
  expect(onConfirm).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "确认移除标签" }));
  expect(onConfirm).toHaveBeenCalledWith(["待复核", "客户可见"]);
});

it("returns from the removal preview to the input without committing", async () => {
  const onConfirm = await renderDialog("remove_tag");

  fireEvent.change(screen.getByRole("textbox", { name: "标签" }), {
    target: { value: "待复核" },
  });
  fireEvent.click(screen.getByRole("button", { name: "移除标签" }));
  fireEvent.click(screen.getByRole("button", { name: "上一步" }));

  expect(screen.getByText("批量移除标签")).toBeVisible();
  expect(onConfirm).not.toHaveBeenCalled();
});

it("adds tags directly without an extra confirmation step", async () => {
  const onConfirm = await renderDialog("add_tag");

  fireEvent.change(screen.getByRole("textbox", { name: "标签" }), {
    target: { value: "review" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加标签" }));

  expect(onConfirm).toHaveBeenCalledWith(["review"]);
});
