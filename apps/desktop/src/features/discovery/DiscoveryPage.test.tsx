import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createMockImportFacade } from "../import/api";
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

it("reports committed imports and lets the user open the refreshed library", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["en-US"]);
  const onImportComplete = vi.fn();
  const onOpenLibrary = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage
        importFacade={createMockImportFacade({ scenario: "safe-local" })}
        onImportComplete={onImportComplete}
        onOpenLibrary={onOpenLibrary}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getAllByRole("button", { name: "Import Skill" })[0]);
  await user.type(screen.getByLabelText("Source"), "C:\\Skills");
  await user.click(screen.getByRole("button", { name: "Parse source" }));
  await user.click(await screen.findByRole("button", { name: "Continue to candidate selection" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "Analyze conflicts" }));
  await user.click(await screen.findByRole("button", { name: "Commit import" }));

  expect(onImportComplete).toHaveBeenCalledWith([
    expect.objectContaining({ status: "succeeded" }),
  ]);
  await user.click(await screen.findByRole("button", { name: "Open Skill library" }));
  expect(onOpenLibrary).toHaveBeenCalledTimes(1);
});

it("opens the guided import flow with the first scanned source prefilled", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage
        initialSources={["C:\\Users\\Test\\.codex\\skills", "C:\\Users\\Test\\.claude\\skills"]}
        initialSourceText={"C:\\Users\\Test\\.codex\\skills"}
      />
    </I18nextProvider>,
  );

  expect(await screen.findByRole("heading", { name: "导入 Skill" })).toBeVisible();
  expect(screen.getByText("初始化扫描发现 2 个来源目录，已默认全部选中，将在同一流程中批量导入。"))
    .toBeVisible();
  expect(screen.getByLabelText("来源")).toHaveValue("C:\\Users\\Test\\.codex\\skills");
});
