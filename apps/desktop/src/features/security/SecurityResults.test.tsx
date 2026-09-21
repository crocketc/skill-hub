import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
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
  runBasicCheck?: (skillId: string, versionId: string) => Promise<void>;
  runLlmCheck?: (skillId: string, versionId: string) => Promise<void>;
  cancelLlmCheck?: (operationId: string) => Promise<void>;
  listRunningLlmChecks?: () => Promise<Array<{ skillId: string; versionId: string; operationId: string }>>;
  onDisposition?: (call: DispositionCall) => void;
  tracker?: OperationTracker;
  /** 非空时处置命令按该原因失败，用于验证失败反馈。 */
  dispositionRejection?: unknown;
  /** 挂载全局通知中心，用于断言统一反馈的可见结果。 */
  withNotices?: boolean;
}

async function renderSecurity({ checks, findings, preferences, runBasicCheck, runLlmCheck, cancelLlmCheck, listRunningLlmChecks, onDisposition, tracker, dispositionRejection, withNotices }: FacadeOverrides) {
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
      if (dispositionRejection !== undefined) throw dispositionRejection;
    },
    ...(preferences === undefined ? {} : { getPreferences: async () => preferences }),
    ...(runBasicCheck ? { runBasicCheck: vi.fn(runBasicCheck) } : {}),
    runLlmCheck: runSpy,
    ...(cancelLlmCheck ? { cancelLlmCheck: vi.fn(cancelLlmCheck) } : {}),
    ...(listRunningLlmChecks ? { listRunningLlmChecks: vi.fn(listRunningLlmChecks) } : {}),
  };

  const i18n = await createSkillHubI18n(["zh-CN"]);
  // Provider 顺序与生产一致（i18n 在外、通知中心在内）：否则 toast 区拿不到
  // i18n 实例，通知文案会退化成未翻译的键名。
  const tree = (
    <I18nextProvider i18n={i18n}>
      <SecurityResults facade={facade} skillId="skill-pdf" tracker={tracker} versionId="v1" />
    </I18nextProvider>
  );
  const view = render(
    withNotices
      ? (
          <I18nextProvider i18n={i18n}>
            <AppNotificationsProvider>{tree}</AppNotificationsProvider>
          </I18nextProvider>
        )
      : tree,
  );
  const cancelSpy = facade.cancelLlmCheck ?? vi.fn();
  return { dispositionCalls, listFindings, runSpy, cancelSpy, ...view };
}

it("offers the deterministic basic check action and refreshes its facts", async () => {
  const runBasicCheck = vi.fn(async () => undefined);
  const view = await renderSecurity({ runBasicCheck });

  const run = await screen.findByRole("button", { name: "运行基础检查" });
  fireEvent.click(run);

  await waitFor(() => expect(runBasicCheck).toHaveBeenCalledWith("skill-pdf", "v1"));
  expect(view.listFindings).toHaveBeenCalledTimes(2);
});

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

it("labels high-risk findings visibly before any disposition choice", async () => {
  await renderSecurity({
    findings: [
      makeFinding({ id: "f-1", file: "SKILL.md", highRisk: true }),
      makeFinding({ id: "f-2", file: "scripts/run.py", highRisk: false }),
    ],
  });

  expect(await screen.findByText("高风险")).toBeVisible();
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

describe("SecurityResults 与统一执行桥", () => {
  it("reports the AI check to the unified tracker while running and finishes with success", async () => {
    let resolveRun: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const tracker = createOperationTracker();
    const { rerender } = await renderSecurity({
      preferences: { llmProvider: "local-model", dataScope: "explicit_selection" },
      runLlmCheck: async () => {
        await gate;
      },
      listRunningLlmChecks: async () => [
        { skillId: "skill-pdf", versionId: "v1", operationId: "op-live" },
      ],
      tracker,
    });

    fireEvent.click(await screen.findByRole("button", { name: "运行 AI 检查" }));
    expect(await screen.findByText("AI 检查进行中，结果将在完成后展示。")).toBeVisible();

    const [inFlight] = tracker.getSnapshot();
    expect(inFlight.status).toBe("running");
    expect(inFlight.kind).toBe("ai_check");
    expect(inFlight.canCancel).toBe(true);
    // 运行中被发现的持久化 operation id 随时关联到同一投影。
    expect(inFlight.operationId).toBe("op-live");
    expect(inFlight.targetHref).toBe("/operations/op-live");

    resolveRun();
    await waitFor(() => {
      expect(screen.queryByText("AI 检查进行中，结果将在完成后展示。")).not.toBeInTheDocument();
    });
    rerender(<div />);
    const [finished] = tracker.getSnapshot();
    expect(finished.status).toBe("success");
  });

  it("finishes a user-cancelled AI check as cancelled (not failed) in the tracker", async () => {
    let resolveRun: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const tracker = createOperationTracker();
    await renderSecurity({
      preferences: { llmProvider: "local-model", dataScope: "explicit_selection" },
      runLlmCheck: async () => {
        await gate;
        throw new Error("operation cancelled");
      },
      listRunningLlmChecks: async () => [
        { skillId: "skill-pdf", versionId: "v1", operationId: "op-live" },
      ],
      cancelLlmCheck: async () => {
        resolveRun();
      },
      tracker,
    });

    fireEvent.click(await screen.findByRole("button", { name: "运行 AI 检查" }));
    const cancel = await screen.findByRole("button", { name: "取消检查" });
    fireEvent.click(cancel);

    await waitFor(() => {
      const [operation] = tracker.getSnapshot();
      expect(operation.status).toBe("cancelled");
    });
  });

  it("records run failures on the tracker and keeps the inline error without swallowing", async () => {
    const tracker = createOperationTracker();
    await renderSecurity({
      preferences: { llmProvider: "local-model", dataScope: "explicit_selection" },
      findings: [makeFinding({ id: "lf-1", kind: "llm" })],
      runLlmCheck: async () => {
        throw new Error("提供商未就绪");
      },
      tracker,
    });

    fireEvent.click(await screen.findByRole("button", { name: "运行 AI 检查" }));
    expect(await screen.findByText("AI 检查运行失败：提供商未就绪")).toBeVisible();

    const [failed] = tracker.getSnapshot();
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("提供商未就绪");
  });
});

describe("发现项处置与统一执行反馈", () => {
  it("reports a saved disposition as one notice and keeps it out of the in-flight top bar", async () => {
    const tracker = createOperationTracker();
    const { dispositionCalls } = await renderSecurity({
      dispositionRejection: undefined,
      findings: [makeFinding({ id: "lr-1" })],
      tracker,
      withNotices: true,
    });

    fireEvent.click(await screen.findByRole("button", { name: "确认已知晓" }));

    await waitFor(() => expect(dispositionCalls).toHaveLength(1));
    expect(dispositionCalls[0]).toMatchObject({ disposition: "acknowledged", highRiskConfirmed: false });
    // 单次同步写入：只要结果反馈，不占用在途顶栏。
    expect(tracker.getSnapshot()).toEqual([]);
    const notice = await screen.findByTestId("notice-success");
    expect(notice).toHaveTextContent("已记录处置结果：已知晓");
  });

  it("surfaces a rejected disposition as a danger notice plus an inline alert, keeping the old disposition", async () => {
    const tracker = createOperationTracker();
    const { dispositionCalls } = await renderSecurity({
      dispositionRejection: { code: "security.disposition_save_failed" },
      findings: [makeFinding({ id: "lr-1" })],
      tracker,
      withNotices: true,
    });

    fireEvent.click(await screen.findByRole("button", { name: "确认已知晓" }));

    await waitFor(() => expect(dispositionCalls).toHaveLength(1));
    const notice = await screen.findByTestId("notice-danger");
    expect(notice).toHaveTextContent("处置未能保存");
    // 原生命令以结构化 AppError 拒绝：通知的补充说明必须可读，
    // 不能把整个对象 String() 成 "[object Object]"。
    const detail = notice.querySelector(".sh-notification__detail");
    expect(detail?.textContent).not.toContain("[object Object]");
    expect(detail?.textContent).toContain("security.disposition_save_failed");
    // 处置未被记入列表：操作入口仍在，说明保存失败没有被当成成功。
    expect(await screen.findByRole("button", { name: "确认已知晓" })).toBeVisible();
    expect(tracker.getSnapshot()).toEqual([]);
  });

  it("records the cancel request on the tracked operation before the backend confirms", async () => {
    let releaseCancel: () => void = () => {};
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const tracker = createOperationTracker();
    await renderSecurity({
      preferences: { llmProvider: "local-model", dataScope: "explicit_selection" },
      runLlmCheck: async () => {
        await runGate;
      },
      listRunningLlmChecks: async () => [
        { skillId: "skill-pdf", versionId: "v1", operationId: "op-live" },
      ],
      cancelLlmCheck: async () => {
        await cancelGate;
      },
      tracker,
    });

    fireEvent.click(await screen.findByRole("button", { name: "运行 AI 检查" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消检查" }));

    // 用户动作先记账，后端确认前顶栏即可看到「已请求取消」。
    await waitFor(() => {
      const [operation] = tracker.getSnapshot();
      expect(operation.cancelRequested).toBe(true);
    });
    expect(tracker.getSnapshot()[0].status).toBe("running");

    releaseCancel();
    releaseRun();
    await waitFor(() => {
      const [operation] = tracker.getSnapshot();
      expect(operation.status).toBe("cancelled");
    });
  });
});
