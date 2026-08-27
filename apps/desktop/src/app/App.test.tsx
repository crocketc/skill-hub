import { act, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../i18n";
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
