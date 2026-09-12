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

// P2-01：页面级留白节奏统一——PageFrame 不再自带第二层内边距（AppShell
// 内容区已统一提供 --space-5 留白），页头与正文之间的 section gap 一律
// 消费 --page-gap token，不得在页面级各写一档。
describe("unified page whitespace rhythm", () => {
  it("renders the page frame without a second padding layer", () => {
    const frameStart = baseCss.indexOf(".sh-page-frame {");
    const frameBlock = baseCss.slice(frameStart, baseCss.indexOf("}", frameStart) + 1);
    expect(frameBlock, "page frame must not stack padding on the shell padding").not.toMatch(
      /padding:/,
    );
  });

  it("drives the page frame section gap from the shared page-gap token", () => {
    const frameStart = baseCss.indexOf(".sh-page-frame {");
    const frameBlock = baseCss.slice(frameStart, baseCss.indexOf("}", frameStart) + 1);
    expect(frameBlock).toMatch(/gap:\s*var\(--page-gap\)/);
  });

  it("drives the discovery page section gap from the shared page-gap token", () => {
    const pageStart = baseCss.indexOf(".sh-discovery-page {");
    const pageBlock = baseCss.slice(pageStart, baseCss.indexOf("}", pageStart) + 1);
    expect(pageBlock).toMatch(/gap:\s*var\(--page-gap\)/);
  });
});
