import { act, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../i18n";
import baseCss from "../styles/base.css?raw";
import { App } from "./App";

it("renders the local bootstrap state without network access", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <App bootstrap={{ phase: "loading_local", locale: "zh-CN" }} />
    </I18nextProvider>,
  );
  expect(screen.getByText("正在读取本地数据")).toBeInTheDocument();
});

it("renders the bootstrap state in the selected interface language", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <App bootstrap={{ phase: "loading_local", locale: "en-US" }} />
    </I18nextProvider>,
  );

  expect(screen.getByText("Reading local data")).toBeInTheDocument();
});

it("keeps rendered and document language synchronized after switching", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <App bootstrap={{ phase: "loading_local", locale: "en-US" }} />
    </I18nextProvider>,
  );

  await act(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  expect(screen.getByRole("main")).toHaveAttribute("lang", "zh-CN");
  expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
  expect(screen.getByText("正在读取本地数据")).toBeInTheDocument();
});

it("keeps the app shell within the viewport and scrolls content whenever it overflows", () => {
  const shellStart = baseCss.indexOf(".sh-app-shell {");
  const shellBlock = baseCss.slice(shellStart, baseCss.indexOf("}", shellStart) + 1);
  const contentStart = baseCss.indexOf(".sh-app-shell__content {");
  const contentBlock = baseCss.slice(contentStart, baseCss.indexOf("}", contentStart) + 1);
  expect(shellBlock).toMatch(/height:\s*100dvh/);
  expect(shellBlock).toMatch(/overflow:\s*hidden/);
  expect(contentBlock).toMatch(/min-height:\s*0/);
  // Scrollbars must be driven by content overflow, not by the zoom scale.
  expect(contentBlock).toMatch(/overflow-y:\s*auto/);
});

it("never hides overflowing page content behind overflow-y hidden", () => {
  const contentStart = baseCss.indexOf(".sh-app-shell__content {");
  const contentBlock = baseCss.slice(contentStart, baseCss.indexOf("}", contentStart) + 1);
  expect(contentBlock).not.toMatch(/overflow-y:\s*hidden/);
  expect(contentBlock).toMatch(/scrollbar-gutter:\s*stable/);
});

it("keeps the guided import route scrollable inside the default desktop viewport", () => {
  const routeStart = baseCss.indexOf(".sh-discovery-page--import {");
  const routeBlock = baseCss.slice(routeStart, baseCss.indexOf("}", routeStart) + 1);
  const wizardStart = baseCss.lastIndexOf(".sh-import-wizard {");
  const wizardBlock = baseCss.slice(wizardStart, baseCss.indexOf("}", wizardStart) + 1);

  expect(routeBlock).toMatch(/height:\s*100%/);
  expect(routeBlock).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  expect(wizardBlock).toMatch(/height:\s*100%/);
  expect(wizardBlock).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\)/);
});
