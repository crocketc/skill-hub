import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";import { createOperationTracker } from "../../platform/operationTracker";
import { createMockSkillDetailFacade } from "./testFixtures";
import { SemanticDuplicatePanel } from "./SemanticDuplicatePanel";
import type { SkillDetailFacade } from "./api";

async function renderPanel(
  facade: SkillDetailFacade,
  deterministicCandidates: string[] = [],
  tracker = createOperationTracker(),
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <SemanticDuplicatePanel
          deterministicCandidates={deterministicCandidates}
          facade={facade}
          skillId="skill-pdf"
          tracker={tracker}
        />
      </MemoryRouter>
    </I18nextProvider>,
  );
  return tracker;
}

describe("SemanticDuplicatePanel", () => {
  it("shows deterministic candidates immediately without running the AI layer", async () => {
    const facade = createMockSkillDetailFacade();
    await renderPanel(facade, ["PDF Reader（副本）"]);

    // P1-12：确定性候选来自 getInsights，页面加载即可见，不需要点击"运行分析"。
    expect(screen.getByRole("heading", { name: "确定性重复候选" })).toBeVisible();
    expect(screen.getByText(/由当前版本内容计算/)).toBeVisible();
    expect(screen.getByText("PDF Reader（副本）")).toBeVisible();
    expect(facade.calls.analyzedDuplicateSkills).toEqual([]);
    // 可选 AI 层保持未运行：没有报告、没有候选报告列表。
    expect(screen.queryByText(/结果来源/)).not.toBeInTheDocument();
  });

  it("states the empty deterministic result honestly and keeps the AI layer idle", async () => {
    const facade = createMockSkillDetailFacade();
    await renderPanel(facade);

    expect(screen.getByRole("heading", { name: "可选 AI 语义分析" })).toBeVisible();
    expect(
      screen.getByText("本地确定性筛选未发现语义候选。"),
    ).toBeVisible();
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
    const reasonLine = screen.getByText(/AI 层失败原因：连接模型服务超时/);
    expect(reasonLine).toBeVisible();
    expect(screen.queryByText(/AI 层失败码/)).not.toBeInTheDocument();
    // describeNativeError 的文案自带句尾句号；模板不得再叠加"；"造成“。；”标点叠用。
    expect(reasonLine.textContent).not.toContain("。；");
    expect(reasonLine.textContent).not.toContain(".;");
    // 分隔安全：reason 必须自成立句，“确定性候选不受影响”是独立元素，
    // 不依赖“keyed 文案自带句尾标点”的隐式不变量与 reason 拼接。
    expect(reasonLine.textContent).not.toContain("确定性候选不受影响");
    expect(screen.getByText("确定性候选不受影响。")).toBeVisible();
    expect(screen.getByText("PDF Text Extractor")).toBeVisible();
    // 无 LLM 时的诚实表达：确定性候选不因 AI 失败而消失。
    expect(screen.getByRole("heading", { name: "确定性重复候选" })).toBeVisible();
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

  it("disables the AI action with an honest note when no provider is configured", async () => {
    const facade = createMockSkillDetailFacade();
    facade.isAiAvailable = async () => false;
    await renderPanel(facade, ["PDF Reader（副本）"]);

    expect(await screen.findByRole("button", { name: "运行分析" })).toBeDisabled();
    expect(
      screen.getByText(
        "尚未配置可用的 LLM 供应商；AI 分析按钮已停用，确定性候选照常展示。",
      ),
    ).toBeVisible();
    // 不可用就不发起分析：绝不伪造结果。
    expect(facade.calls.analyzedDuplicateSkills).toEqual([]);
  });

  // --- 任务 7 清理：不再自带冲突分析入口，只留确定性事实与工作台深链 ---

  it("deep-links to the conflict decisions workspace instead of hosting an AI conflict entry", async () => {
    const facade = createMockSkillDetailFacade();
    await renderPanel(facade);

    // 深链指向冲突处理工作台，AI 分析与裁决集中在那里完成。
    const link = screen.getByRole("link", { name: "前往冲突处理" });
    expect(link).toHaveAttribute("href", "/relationships/decisions");
    expect(
      screen.getByText("冲突组的 AI 分析与裁决集中在冲突处理工作台完成。"),
    ).toBeVisible();
    // 旧的 AI 冲突入口不再出现：无按钮、无结论渲染。
    expect(screen.queryByRole("button", { name: "分析相关冲突" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("conflict-analysis-result")).not.toBeInTheDocument();
    // 确定性候选不受影响，仍然常显。
    expect(screen.getByRole("heading", { name: "确定性重复候选" })).toBeVisible();
    expect(facade.calls.analyzedConflictScopes).toEqual([]);
  });
});

describe("SemanticDuplicatePanel 与统一执行桥", () => {
  it("reports the AI duplicate analysis to the unified tracker from start to finish", async () => {
    const facade = createMockSkillDetailFacade();
    const tracker = await renderPanel(facade);

    fireEvent.click(screen.getByRole("button", { name: "运行分析" }));
    await screen.findByText("结果来源：确定性候选 + AI 语义分析");

    const [operation] = tracker.getSnapshot();
    expect(operation.kind).toBe("ai_analysis");
    expect(operation.status).toBe("success");
  });

  it("keeps the in-flight analysis visible in the tracker while waiting for the facade", async () => {
    const facade = createMockSkillDetailFacade();
    let resolveAnalyze!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveAnalyze = resolve;
    });
    facade.analyzeSemanticDuplicates = async () => {
      await gate;
      return {
        candidates: [],
        failureCode: null,
        source: "llm" as const,
      };
    };
    const tracker = await renderPanel(facade);

    fireEvent.click(screen.getByRole("button", { name: "运行分析" }));
    // 命令未返回：任务保持在途，不得提前落终态。
    expect(tracker.getSnapshot()[0]?.status).toBe("running");

    resolveAnalyze();
    await screen.findByText("结果来源：确定性候选 + AI 语义分析");
    expect(tracker.getSnapshot()[0].status).toBe("success");
  });

  it("records a failed AI analysis on the tracker and keeps the inline alert", async () => {
    const facade = createMockSkillDetailFacade();
    facade.analyzeSemanticDuplicates = async () => {
      throw new Error("提供商未就绪");
    };
    const tracker = await renderPanel(facade);

    fireEvent.click(screen.getByRole("button", { name: "运行分析" }));
    expect(await screen.findByRole("alert")).toBeVisible();

    const [operation] = tracker.getSnapshot();
    expect(operation.status).toBe("failed");
    expect(operation.error).toBe("提供商未就绪");
  });
});
