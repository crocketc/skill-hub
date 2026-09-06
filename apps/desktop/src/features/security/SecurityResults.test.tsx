import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import {
  separateCheckFixture,
  type SecurityCheck,
  type SecurityFacade,
  type SecurityFinding,
  type SecurityPreferences,
} from "./api";
import { SecurityResults } from "./SecurityResults";

function makeFinding(overrides: Partial<SecurityFinding> & Pick<SecurityFinding, "id">): SecurityFinding {
  return {
    code: `code-${overrides.id}`,
    kind: "basic",
    severity: "low",
    highRisk: false,
    disposition: "actionable",
    message: `message-${overrides.id}`,
    ...overrides,
  };
}

type DispositionCall = {
  findingId: string;
  kind: SecurityFinding["kind"];
  disposition: SecurityFinding["disposition"];
  skillId: string;
  versionId: string;
  highRiskConfirmed: boolean;
};

interface FacadeOverrides {
  checks?: SecurityCheck[];
  findings?: SecurityFinding[];
  preferences?: SecurityPreferences;
  runLlmCheck?: (skillId: string, versionId: string) => Promise<void>;
  cancelLlmCheck?: (operationId: string) => Promise<void>;
  listRunningLlmChecks?: () => Promise<Array<{ skillId: string; versionId: string; operationId: string }>>;
  onDisposition?: (call: DispositionCall) => void;
}

async function renderSecurity({ checks, findings, preferences, runLlmCheck, cancelLlmCheck, listRunningLlmChecks, onDisposition }: FacadeOverrides) {
  const dispositionCalls: DispositionCall[] = [];
  const fixture = separateCheckFixture();
  const listFindings = vi.fn(async () => findings ?? fixture.findings);
  const runSpy = vi.fn(runLlmCheck ?? (async () => undefined));
  const facade: SecurityFacade = {
    getChecks: async () => checks ?? fixture.checks,
    listFindings,
    setFindingDisposition: async (finding, disposition, skillId, versionId, highRiskConfirmed) => {
      const call: DispositionCall = {
        findingId: finding.id,
        kind: finding.kind,
        disposition,
        skillId,
        versionId,
        highRiskConfirmed,
      };
      dispositionCalls.push(call);
      onDisposition?.(call);
    },
    ...(preferences === undefined ? {} : { getPreferences: async () => preferences }),
    runLlmCheck: runSpy,
    ...(cancelLlmCheck ? { cancelLlmCheck: vi.fn(cancelLlmCheck) } : {}),
    ...(listRunningLlmChecks ? { listRunningLlmChecks: vi.fn(listRunningLlmChecks) } : {}),
  };

  const i18n = await createSkillHubI18n(["zh-CN"]);
  const view = render(
    <I18nextProvider i18n={i18n}>
      <SecurityResults facade={facade} skillId="skill-pdf" versionId="v1" />
    </I18nextProvider>,
  );
  const cancelSpy = facade.cancelLlmCheck ?? vi.fn();
  return { dispositionCalls, listFindings, runSpy, cancelSpy, ...view };
}

it("renders basic and LLM checks independently and requires explicit confirmation for high-risk handling", async () => {
  const { dispositionCalls } = await renderSecurity({});

  expect(await screen.findByRole("heading", { name: "基础安全检查" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "LLM 安全检查" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "确认已知晓" }));
  const dialog = screen.getByRole("alertdialog", { name: "高风险发现项处置确认" });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认并知晓此项" }));

  await waitFor(() => {
    expect(dispositionCalls).toEqual([
      {
        findingId: "finding-1",
        kind: "basic",
        disposition: "acknowledged",
        skillId: "skill-pdf",
        versionId: "v1",
        highRiskConfirmed: true,
      },
    ]);
  });
});

it("renders file and line evidence when present and a no-location empty state otherwise", async () => {
  await renderSecurity({
    findings: [
      makeFinding({ id: "f-1", file: "SKILL.md", line: 4, lineEnd: 6 }),
      makeFinding({ id: "f-2", file: "scripts/run.py" }),
      makeFinding({ id: "f-3", kind: "llm", severity: "critical" }),
      makeFinding({ id: "f-4", kind: "llm", line: 12, lineEnd: 14 }),
    ],
  });

  expect(await screen.findByText("SKILL.md:4-6")).toBeVisible();
  expect(screen.getByText("scripts/run.py")).toBeVisible();
  expect(screen.getByText("位置不可用")).toBeVisible();
  expect(screen.getByText("L12-14")).toBeVisible();
  expect(screen.getByRole("heading", { name: "基础检查发现" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "AI 检查发现" })).toBeVisible();
});

it("disposes LLM findings with the llm kind and without high-risk confirmation for low-risk items", async () => {
  const { dispositionCalls } = await renderSecurity({
    findings: [makeFinding({ id: "lf-1", kind: "llm" })],
  });

  expect(await screen.findByRole("heading", { name: "AI 检查发现" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "确认已知晓" }));

  await waitFor(() => {
    expect(dispositionCalls).toEqual([
      {
        findingId: "lf-1",
        kind: "llm",
        disposition: "acknowledged",
        skillId: "skill-pdf",
        versionId: "v1",
        highRiskConfirmed: false,
      },
    ]);
  });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("requires the explicit high-risk confirmation dialog when dismissing LLM findings", async () => {
  const { dispositionCalls } = await renderSecurity({
    findings: [makeFinding({ id: "lf-9", kind: "llm", severity: "critical", highRisk: true })],
  });

  expect(await screen.findByRole("heading", { name: "AI 检查发现" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "忽略此项" }));
  const dialog = screen.getByRole("alertdialog", { name: "高风险发现项处置确认" });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认并忽略此项" }));

  await waitFor(() => {
    expect(dispositionCalls).toEqual([
      {
        findingId: "lf-9",
        kind: "llm",
        disposition: "dismissed",
        skillId: "skill-pdf",
        versionId: "v1",
        highRiskConfirmed: true,
      },
    ]);
  });
});

it("disables the AI check entry with an explanation when no LLM provider is configured", async () => {
  const { runSpy } = await renderSecurity({
    preferences: { llmProvider: "", dataScope: "explicit_selection" },
  });

  expect(await screen.findByText("未配置 LLM 提供商，AI 检查不可用")).toBeVisible();
  expect(screen.queryByText("仅发送显式选择的 Skill 内容")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "运行 AI 检查" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "运行 AI 检查" }));
  await waitFor(() => {
    expect(runSpy).not.toHaveBeenCalled();
  });
});

it("explains the send scope for explicit selection and refreshes results after running the AI check", async () => {
  const { listFindings, runSpy } = await renderSecurity({
    preferences: { llmProvider: "local-model", dataScope: "explicit_selection" },
    findings: [makeFinding({ id: "lf-1", kind: "llm" })],
  });

  expect(await screen.findByText("仅发送显式选择的 Skill 内容")).toBeVisible();
  expect(screen.getByRole("button", { name: "运行 AI 检查" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "运行 AI 检查" }));

  await waitFor(() => {
    expect(runSpy).toHaveBeenCalledWith("skill-pdf", "v1");
    expect(listFindings).toHaveBeenCalledTimes(2);
  });
});

it("surfaces run failures inline without discarding the recorded findings", async () => {  const { runSpy } = await renderSecurity({
    preferences: { llmProvider: "local-model", dataScope: "explicit_selection" },
    findings: [makeFinding({ id: "lf-1", kind: "llm" })],
    runLlmCheck: async () => {
      throw new Error("提供商未就绪");
    },
  });

  expect(await screen.findByText("仅发送显式选择的 Skill 内容")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "运行 AI 检查" }));

  expect(await screen.findByText("AI 检查运行失败：提供商未就绪")).toBeVisible();
  expect(screen.getByRole("heading", { name: "AI 检查发现" })).toBeVisible();
  expect(runSpy).toHaveBeenCalledOnce();
});

it("shows progress and a cancel entry that targets the running operation", async () => {
  let resolveRun: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  const { cancelSpy } = await renderSecurity({
    preferences: { llmProvider: "local-model", dataScope: "explicit_selection" },
    runLlmCheck: async () => {
      await gate;
    },
    listRunningLlmChecks: async () => [
      { skillId: "skill-pdf", versionId: "v1", operationId: "op-live" },
    ],
    cancelLlmCheck: async () => {
      resolveRun();
    },
  });

  expect(await screen.findByText("仅发送显式选择的 Skill 内容")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "运行 AI 检查" }));

  expect(await screen.findByText("AI 检查进行中，结果将在完成后展示。")).toBeVisible();
  const cancel = await screen.findByRole("button", { name: "取消检查" });
  fireEvent.click(cancel);

  await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith("op-live"));
  await waitFor(() =>
    expect(screen.queryByText("AI 检查进行中，结果将在完成后展示。")).not.toBeInTheDocument(),
  );
});

it("shows the raw data scope next to the AI check when it is not the explicit-selection default", async () => {
  await renderSecurity({
    preferences: { llmProvider: "openai", dataScope: "aggregate_usage" },
  });

  expect(await screen.findByText("当前发送范围：aggregate_usage")).toBeVisible();
});
