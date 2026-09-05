import { fireEvent, render, screen } from "@testing-library/react";
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

it("filters pending work by its actual kind", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: PendingFacade = {
    list: async () => [
      { id: "trial", subject: "skill-a", kind: "trial_due", code: "trial", message: "trial" },
      { id: "recovery", subject: "未完成部署", kind: "recovery", code: "recovery", message: "recovery" },
    ],
    resolve: async () => undefined,
    recheck: async () => undefined,
    convert: async () => undefined,
    remove: async () => undefined,
    recover: async () => undefined,
  };
  render(<I18nextProvider i18n={i18n}><PendingPage facade={facade} /></I18nextProvider>);
  await screen.findByText("skill-a");

  fireEvent.change(screen.getByLabelText("事项类型"), { target: { value: "recovery" } });

  expect(screen.getByText("未完成部署")).toBeInTheDocument();
  expect(screen.queryByText("skill-a")).not.toBeInTheDocument();
});
