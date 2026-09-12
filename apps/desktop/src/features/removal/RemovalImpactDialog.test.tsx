import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { removalImpactFixture } from "./api";
import { RemovalImpactDialog } from "./RemovalImpactDialog";

it("requires a choice for each deployment before deleting the central Skill", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RemovalImpactDialog impact={removalImpactFixture()} onConfirm={() => undefined} />
    </I18nextProvider>,
  );

  expect(screen.getAllByRole("combobox", { name: /部署处理方式/ })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "确认从库中删除" })).toBeDisabled();
});

it("names the object as deleting the library Skill and states retention and recovery up front", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RemovalImpactDialog impact={removalImpactFixture()} onConfirm={() => undefined} />
    </I18nextProvider>,
  );

  // 对象 4 唯一名称“删除库中 Skill”：不再共用笼统的“从托管库移除”。
  expect(screen.getByRole("heading", { name: "从库中删除 PDF Reader 吗？" })).toBeVisible();
  expect(screen.queryByText(/要从托管库移除/)).not.toBeInTheDocument();

  // 部署决策名与对象一一对应，不复用裸词“移除部署”。
  const options = screen.getAllByRole("option").map((option) => option.textContent);
  expect(options).toContain("删除目标目录中的部署副本（取消部署）");
  expect(options).toContain("转为独立副本（保留目标文件，移除部署关系）");
  expect(options).not.toContain("移除部署");

  // 固定两行：保留什么 + 恢复方式（如实提示仅备份可恢复）。
  expect(screen.getByText(/保留：SkillHub 之外的原文件不受影响/)).toBeVisible();
  expect(screen.getByText(/恢复：从库中删除无法在应用内撤销/)).toBeVisible();
  expect(screen.getByText(/导出备份/)).toBeVisible();
});

it("moves focus into the impact dialog on open and restores it to the trigger on close", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);

  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)} type="button">打开删除影响</button>
        {open ? (
          <RemovalImpactDialog
            impact={removalImpactFixture()}
            onCancel={() => setOpen(false)}
            onConfirm={() => undefined}
          />
        ) : null}
      </>
    );
  }

  render(
    <I18nextProvider i18n={i18n}>
      <Host />
    </I18nextProvider>,
  );

  const trigger = screen.getByRole("button", { name: "打开删除影响" });
  trigger.focus();
  await user.click(trigger);

  expect(screen.getByRole("heading", { name: /从库中删除/ })).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(trigger).toHaveFocus();
});

it("presents the commit failure as an icon-plus-text alert instead of bare prose", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RemovalImpactDialog
        error="删除未完成。集中库未被改动，请检查后重试。"
        impact={removalImpactFixture()}
        onConfirm={() => undefined}
      />
    </I18nextProvider>,
  );

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("删除未完成。集中库未被改动，请检查后重试。");
  expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});
