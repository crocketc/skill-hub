import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createMockSkillDetailFacade } from "./testFixtures";
import { SemanticDuplicatePanel } from "./SemanticDuplicatePanel";
import type { SkillDetailFacade } from "./api";

async function renderPanel(facade: SkillDetailFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SemanticDuplicatePanel facade={facade} skillId="skill-pdf" />
    </I18nextProvider>,
  );
}

describe("SemanticDuplicatePanel", () => {
  it("stays idle until the user explicitly runs the analysis", async () => {
    const facade = createMockSkillDetailFacade();
    await renderPanel(facade);

    expect(screen.getByRole("heading", { name: "AI 语义重复分析" })).toBeVisible();
    expect(screen.queryByText("候选对象")).not.toBeInTheDocument();
    expect(facade.calls.analyzedDuplicateSkills).toEqual([]);
  });

  it("runs the analysis through the facade and shows the AI report", async () => {
    const facade = createMockSkillDetailFacade();
    await renderPanel(facade);

    fireEvent.click(screen.getByRole("button", { name: "运行分析" }));
    const source = await screen.findByText("结果来源：确定性候选 + AI 语义分析");
    expect(source).toBeVisible();
    expect(screen.getByText("PDF Text Extractor")).toBeVisible();
    expect(facade.calls.analyzedDuplicateSkills).toEqual(["skill-pdf"]);
    expect(
      screen.getByText(/合并、删除、归档等操作始终需要你另行确认/),
    ).toBeVisible();
  });

  it("surfaces the deterministic fallback with the failure code when the AI layer fails", async () => {
    const facade = createMockSkillDetailFacade();
    facade.analyzeSemanticDuplicates = async () => ({
      candidates: [
        {
          basicCheckState: "passed",
          description: "Reads text out of PDF files",
          id: "skill-pdf-alt",
          locallyModified: false,
          name: "PDF Text Extractor",
          permissions: [],
          source: "github.com/example/pdf-extractor",
          trigger: "pdf text",
        },
      ],
      failureCode: "llm.request_timeout",
      source: "deterministic_only",
    });
    await renderPanel(facade);

    fireEvent.click(screen.getByRole("button", { name: "运行分析" }));
    expect(
      await screen.findByText("结果来源：仅确定性候选（AI 层未返回结果）"),
    ).toBeVisible();
    expect(
      screen.getByText(/AI 层失败原因：连接模型服务超时，请检查网络后重试。/),
    ).toBeVisible();
    expect(screen.queryByText(/AI 层失败码/)).not.toBeInTheDocument();
    expect(screen.getByText("PDF Text Extractor")).toBeVisible();
  });

  it("describes a rejected analysis in readable copy and keeps the deterministic promise", async () => {
    const facade = createMockSkillDetailFacade();
    facade.analyzeSemanticDuplicates = async () => {
      throw { code: "llm.not_configured", severity: "error", params: {}, actions: [] };
    };
    await renderPanel(facade);

    fireEvent.click(screen.getByRole("button", { name: "运行分析" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("AI 分析未能完成：尚未配置可用的 LLM 供应商，请先添加并启用供应商。");
    expect(alert.textContent).not.toContain("[object Object]");
    expect(
      screen.getByText(/AI 分析未执行，确定性重复候选仍然可用/),
    ).toBeVisible();
  });
});
