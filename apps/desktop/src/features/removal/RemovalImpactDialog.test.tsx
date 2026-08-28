import { render, screen } from "@testing-library/react";
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
