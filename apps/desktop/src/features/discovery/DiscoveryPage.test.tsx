import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { DiscoveryPage } from "./DiscoveryPage";

it("shows local and online discovery entry points without runtime claims", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "本地发现" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "在线发现" })).toBeVisible();
  expect(screen.queryByText(/已授权|可用|验证通过/)).not.toBeInTheDocument();
});

it("opens the production import wizard without showing mock candidates", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage />
    </I18nextProvider>,
  );

  fireEvent.click(screen.getAllByRole("button", { name: "导入 Skill" })[0]);

  expect(await screen.findByRole("heading", { name: "导入 Skill" })).toBeVisible();
  expect(screen.queryByText(/导入能力尚未连接/)).not.toBeInTheDocument();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("uses the supplied facade only for the import wizard entry", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const importFacade = { cancel: vi.fn() } as never;
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage importFacade={importFacade} />
    </I18nextProvider>,
  );

  expect(screen.getAllByRole("button", { name: "Import Skill" })[0]).toBeVisible();
});
