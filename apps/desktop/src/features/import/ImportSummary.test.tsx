import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportResult } from "./api";
import { ImportSummary } from "./ImportSummary";

const results: ImportResult[] = [
  { candidateId: "a", action: "copy", status: "succeeded", message: "已导入" },
  { candidateId: "b", action: "skip", status: "skipped", message: "已跳过" },
  { candidateId: "c", action: "independent", status: "failed", message: "写入失败" },
];

it("renders partial success without collapsing skipped or failed candidates", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary results={results} onRetry={vi.fn()} onOpenLibrary={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getAllByText("已导入")[0]).toBeVisible();
  expect(screen.getAllByText("已跳过")[0]).toBeVisible();
  expect(screen.getByText("写入失败")).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

it("shows the unavailable boundary without fabricating import results", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary unavailable onRetry={vi.fn()} onOpenLibrary={vi.fn()} results={[]} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("导入功能尚未连接到本机服务");
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});
