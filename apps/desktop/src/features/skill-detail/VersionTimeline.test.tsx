import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { SkillDetailSummary } from "./api";
import { createMockSkillDetailFacade } from "./testFixtures";
import { VersionTimeline } from "./VersionTimeline";

async function renderTimeline(
  facade = createMockSkillDetailFacade(),
  summary?: SkillDetailSummary,
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <VersionTimeline facade={facade} skillId="skill-pdf" summary={summary} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return facade;
}

describe("VersionTimeline", () => {
  it("surfaces the upstream update review entry without pretending to apply it", async () => {
    await renderTimeline(createMockSkillDetailFacade(), {
      agentDeploymentCount: 1,
      aiCheck: "not_run",
      basicCheck: "passed",
      currentVersion: "v2.4.1",
      highRiskCount: 0,
      id: "skill-pdf",
      lifecycle: "active",
      name: "PDF Reader",
      pendingCount: 0,
      projectDeploymentCount: 1,
      purpose: "Read PDFs",
      upgradeAvailable: true,
      upstreamVersion: "v2.5.0",
    });

    expect(await screen.findByRole("heading", { name: "上游更新可用" })).toBeVisible();
    expect(screen.getByText("当前 v2.4.1 → 上游 v2.5.0")).toBeVisible();
    expect(screen.getByRole("button", { name: "查看更新差异" })).toBeDisabled();
    expect(screen.getByText("上游更新比较尚未连接")).toBeVisible();
  });

  it("compares exactly two selected versions", async () => {
    await renderTimeline();
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 v2.4.1 进行比较" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 v2.4.0 进行比较" }));
    fireEvent.click(screen.getByRole("button", { name: "比较所选版本" }));
    expect(await screen.findByText("新增文件：1")).toBeVisible();
    expect(screen.getByText("修改文件：2")).toBeVisible();
    expect(screen.getByText("references/new-format.md")).toBeVisible();
    expect(screen.getByText("SKILL.md")).toBeVisible();
    expect(screen.getByText("references/tables.md")).toBeVisible();
  });

  it("previews affected and pinned deployments before rollback", async () => {
    const facade = await renderTimeline();
    fireEvent.click(await screen.findByRole("button", { name: "回滚到 v2.4.0" }));
    expect(await screen.findByText("Codex CLI 将更新")).toBeVisible();
    expect(screen.getByText("Demo Project 固定版本不受影响")).toBeVisible();
    expect(screen.getByText("回滚后重新执行基础安全检查")).toBeVisible();
    expect(facade.calls.committedRollbacks).toEqual([]);
  });

  it("blocks duplicate rollback submission and preserves impact after failure", async () => {
    const facade = createMockSkillDetailFacade({ failRollbackCommit: true });
    await renderTimeline(facade);
    fireEvent.click(await screen.findByRole("button", { name: "回滚到 v2.4.0" }));
    const confirm = await screen.findByRole("button", { name: "确认创建回滚版本" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(facade.calls.committedRollbacks).toHaveLength(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("回滚未完成");
    expect(screen.getByText("Demo Project 固定版本不受影响")).toBeVisible();
  });
});
