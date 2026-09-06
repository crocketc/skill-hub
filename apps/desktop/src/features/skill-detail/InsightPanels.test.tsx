import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";

async function renderEvidence(facade = createMockSkillDetailFacade()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/library/skill-pdf"]}>
          <Routes>
            <Route element={<SkillDetailPage facade={facade} />} path="/library/:skillId" />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("Skill detail evidence panels", () => {
  it("labels requirements as declared without claiming installation or verification", async () => {
    await renderEvidence();
    expect(await screen.findByText("Poppler")).toBeVisible();
    expect(screen.getByText("仅来自 Skill 声明，SkillHub 未安装或验证")).toBeVisible();
    expect(screen.queryByText(/已安装|运行验证通过/)).not.toBeInTheDocument();
  });

  it("shows current basic findings in the security section", async () => {
    await renderEvidence();
    expect(await screen.findByText("检查发现项")).toBeVisible();
    expect(screen.getByText("fixture_rule")).toBeVisible();
    expect(screen.getAllByText(/SKILL\.md/)[0]).toBeVisible();
  });

  it("keeps successful panels visible when relations fail", async () => {
    await renderEvidence(createMockSkillDetailFacade({ failRelations: true }));
    expect(await screen.findByRole("alert", { name: "关系加载失败" })).toBeVisible();
    expect(screen.getByText("Poppler")).toBeVisible();
    expect(screen.getByText("基础安全检查")).toBeVisible();
  });

  it("omits usage evidence when reliability is not established", async () => {
    await renderEvidence(createMockSkillDetailFacade({ usageEvidence: null }));
    expect(await screen.findByText("外部变化与操作历史")).toBeVisible();
    expect(screen.queryByText("使用证据")).not.toBeInTheDocument();
  });

  it("explains honestly when the operation history is not skill-scoped", async () => {
    await renderEvidence(
      createMockSkillDetailFacade({ operationHistoryLimitation: "skill_dimension_not_recorded" }),
    );
    expect(await screen.findByText("外部变化与操作历史")).toBeVisible();
    expect(
      screen.getByText("操作日志暂未记录 Skill 维度，以下为全局日志记录。"),
    ).toBeVisible();
    expect(screen.getByText("Imported")).toBeVisible();
  });

  it("retries a failed relation panel without reloading successful panels", async () => {
    await renderEvidence(createMockSkillDetailFacade({ failRelationsOnce: true }));
    const retry = await screen.findByRole("button", { name: "重试关系" });
    expect(screen.getByText("Poppler")).toBeVisible();
    fireEvent.click(retry);
    expect(await screen.findByText("Codex CLI")).toBeVisible();
    expect(screen.getByText("Poppler")).toBeVisible();
  });

  it("shows two logical relations connected to one physical target", async () => {
    await renderEvidence(createMockSkillDetailFacade({ sharedPhysicalTarget: true }));
    expect(await screen.findAllByTestId("logical-target")).toHaveLength(2);
    expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
  });
});
