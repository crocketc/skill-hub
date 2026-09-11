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
  expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
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

  expect(screen.getByRole("heading", { name: /要从托管库移除/ })).toHaveFocus();

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
