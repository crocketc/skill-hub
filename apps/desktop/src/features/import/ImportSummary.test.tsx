import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportResult } from "./api";
import { ImportSummary } from "./ImportSummary";

const results: ImportResult[] = [
  { candidateId: "a", action: "copy", status: "succeeded", message: "已导入" },
  { candidateId: "b", action: "skip", status: "skipped", message: "已跳过" },
  { candidateId: "c", action: "independent", status: "failed", message: "写入失败" },
];

it("summarizes all outcomes and expands successful details only on request", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary results={results} />
    </I18nextProvider>,
  );

  expect(screen.getByText("成功 1")).toBeVisible();
  expect(screen.getByText("跳过 1")).toBeVisible();
  expect(screen.getByText("失败 1")).toBeVisible();
  expect(screen.getByText("写入失败")).toBeVisible();
  expect(screen.queryByText("已跳过")).not.toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "查看成功和跳过明细" }));
  expect(screen.getAllByText("已导入")[0]).toBeVisible();
  expect(screen.getAllByText("已跳过")[0]).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

it("translates the native loop's structured failure codes into readable copy", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary
        results={[
          {
            candidateId: "c",
            action: "copy",
            status: "failed",
            message: "import.import_failed",
          },
        ]}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("导入未完成：本机服务在处理该候选项时失败。")).toBeVisible();
  expect(screen.queryByText("import.import_failed")).not.toBeInTheDocument();
});

it("shows the unavailable boundary without fabricating import results", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary unavailable results={[]} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("导入功能尚未连接到本机服务");
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});
