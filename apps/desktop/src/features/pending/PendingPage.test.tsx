import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { PendingFacade } from "./api";
import { PendingPage } from "./PendingPage";

it("does not offer a generic delete action for pending work", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: PendingFacade = {
    list: async () => [{ id: "trial", subject: "skill-a", kind: "trial_due", code: "trial", message: "trial" }],
    resolve: async () => undefined,
    recheck: async () => undefined,
    convert: async () => undefined,
    remove: async () => undefined,
    recover: async () => undefined,
  };
  render(<I18nextProvider i18n={i18n}><PendingPage facade={facade} /></I18nextProvider>);
  await screen.findByText("skill-a");
  expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
});
