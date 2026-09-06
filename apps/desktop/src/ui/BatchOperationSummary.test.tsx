import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../i18n";
import { BatchOperationSummary, type BatchOutcome } from "./BatchOperationSummary";

async function renderSummary(outcomes: BatchOutcome[]) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <BatchOperationSummary outcomes={outcomes} />
    </I18nextProvider>,
  );
}

describe("BatchOperationSummary", () => {
  it("groups mixed outcomes into executable, skipped, conflict and failed counts", async () => {
    await renderSummary([
      { id: "a:codex", label: "PDF · Codex CLI", status: "succeeded", message: "已部署" },
      { id: "b:codex", label: "Docs · Codex CLI", status: "skipped", message: "目标不可写" },
      { id: "c:codex", label: "Sheets · Codex CLI", status: "conflict", message: "物理目标被共享" },
      { id: "d:codex", label: "Notes · Codex CLI", status: "failed", message: "权限被拒绝" },
    ]);

    const summary = await screen.findByRole("status");
    expect(summary).toHaveTextContent("成功 1");
    expect(summary).toHaveTextContent("跳过 1");
    expect(summary).toHaveTextContent("冲突 1");
    expect(summary).toHaveTextContent("失败 1");
    expect(screen.getByText("Sheets · Codex CLI")).toBeVisible();
    expect(screen.getByText("物理目标被共享")).toBeVisible();
    expect(screen.getByText("权限被拒绝")).toBeVisible();
  });

  it("renders an honest all-clear state when every outcome succeeded", async () => {
    await renderSummary([
      { id: "a:codex", label: "PDF · Codex CLI", status: "succeeded", message: "已部署" },
    ]);

    expect(await screen.findByRole("status")).toHaveTextContent("成功 1");
    expect(screen.queryByText(/冲突/)).not.toBeInTheDocument();
  });
});
