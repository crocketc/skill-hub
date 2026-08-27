import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { separateCheckFixture, type SecurityFacade } from "./api";
import { SecurityResults } from "./SecurityResults";

it("renders basic and LLM checks independently and refreshes summary after handling", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const invalidations: string[] = [];
  const fixture = separateCheckFixture();
  const facade: SecurityFacade = {
    getChecks: async () => fixture.checks,
    listFindings: async () => fixture.findings,
    setFindingDisposition: async () => {
      invalidations.push("skill-security-summary");
    },
  };

  render(
    <I18nextProvider i18n={i18n}>
      <SecurityResults skillId="skill-pdf" versionId="v1" facade={facade} />
    </I18nextProvider>,
  );

  expect(await screen.findByRole("heading", { name: "基础安全检查" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "LLM 安全检查" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "确认并忽略此项" }));
  expect(invalidations).toContain("skill-security-summary");
});
