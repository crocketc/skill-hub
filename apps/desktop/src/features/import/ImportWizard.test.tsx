import { act, screen, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import { createMockImportFacade } from "./api";
import { ImportWizard } from "./ImportWizard";

async function renderWizard(facade = createMockImportFacade({ scenario: "safe-local" }), tracker?: ReturnType<typeof createOperationTracker>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} tracker={tracker} />
    </I18nextProvider>,
  );
  return facade;
}

async function renderGuidedWizard(facade = createMockImportFacade({ scenario: "safe-local" })) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard
        facade={facade}
        initialSources={["C:/codex/skills", "C:/claude/skills"]}
        initialSourceText="C:/codex/skills"
      />
    </I18nextProvider>,
  );
  return facade;
}

it("parses npx text without executing it and reaches candidate selection", async () => {
  const user = userEvent.setup();
  const facade = await renderWizard();
  await user.type(screen.getByLabelText("来源"), "npx skills add github:owner/repo");
  await user.click(screen.getByRole("button", { name: "解析来源" }));

  expect(await screen.findByText("仅解析来源，不会执行 npx 命令")).toBeVisible();
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.executedCommands).toEqual([]);
});

it("suggests takeover for Agent-owned candidates and requires explicit selection", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "agent-owned-partial" });
  await renderWizard(facade);
  await user.type(screen.getByLabelText("来源"), "C:\\Agents\\codex\\skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  expect(await screen.findByRole("radio", { name: "保留当前位置并纳入管理" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "提交导入" })).toBeDisabled();
});

it("preserves source text after cancellation", async () => {
  const user = userEvent.setup();
  await renderWizard(createMockImportFacade({ scenario: "cancelled" }));
  await user.type(screen.getByLabelText("来源"), "C:\\Skills\\pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "取消获取" }));

  expect(screen.getByLabelText("来源")).toHaveValue("C:\\Skills\\pdf");
});

it("acquires candidates from every selected scanned source", async () => {
  const user = userEvent.setup();
  const facade = await renderGuidedWizard();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));

  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual(["C:/codex/skills", "C:/claude/skills"]);
  expect(screen.getByText("找到 4 个候选项，请先审阅列表。")).toBeVisible();
});

it("keeps the acquire action available and shows per-source counts when the source box is empty", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} initialSources={["C:/codex/skills", "C:/claude/skills"]} initialSourceText="" />
    </I18nextProvider>,
  );

  expect(screen.getByRole("textbox", { name: "来源" })).toHaveValue("");
  const acquire = screen.getByRole("button", { name: "读取已选目录候选" });
  expect(acquire).toBeEnabled();
  await user.click(acquire);

  expect(facade.calls.acquiredSources).toEqual(["C:/codex/skills", "C:/claude/skills"]);
  expect(await screen.findByText("已从 2 个来源目录获取候选")).toBeVisible();
  expect(screen.getByText("C:/codex/skills：2 个候选")).toBeVisible();
  expect(screen.getByText("C:/claude/skills：2 个候选")).toBeVisible();
});

it("normalizes every initialization source before displaying and acquiring it", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const firstSource = "\\\\?\\C:\\Users\\crock\\.claude\\skills";
  const secondSource = "\\\\?\\C:\\Users\\crock\\.codex\\skills";
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard
        facade={facade}
        initialSourceText={firstSource}
        initialSources={[firstSource, secondSource]}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("textbox", { name: "来源" })).toHaveValue("C:\\Users\\crock\\.claude\\skills");
  expect(screen.getByRole("checkbox", { name: "C:\\Users\\crock\\.claude\\skills" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "C:\\Users\\crock\\.codex\\skills" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));

  expect(facade.calls.acquiredSources).toEqual([
    "C:\\Users\\crock\\.claude\\skills",
    "C:\\Users\\crock\\.codex\\skills",
  ]);
});

it("fills the source from the native directory picker", async () => {
  const user = userEvent.setup();
  const picker = { pickDirectory: vi.fn(async () => "\\\\?\\C:\\picked\\skills") };
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard directoryPicker={picker} />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "选择本地目录" }));

  expect(await screen.findByDisplayValue("C:\\picked\\skills")).toBeVisible();
  expect(picker.pickDirectory).toHaveBeenCalledOnce();
});

it("requires a fresh conflict decision when retrying an import", async () => {
  const user = userEvent.setup();
  await renderWizard(createMockImportFacade({ scenario: "conflict-required" }));

  await user.type(screen.getByLabelText("来源"), "C:/incoming");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("radio", { name: "独立导入" }));
  await user.click(screen.getByRole("button", { name: "上一步" }));
  await user.click(screen.getByRole("button", { name: "上一步" }));
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  expect(screen.getByRole("button", { name: "提交导入" })).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: "跳过此候选项" }));
  expect(screen.getByRole("button", { name: "提交导入" })).toBeEnabled();
});

async function renderWithTracker(facade: ReturnType<typeof createMockImportFacade>, tracker: ReturnType<typeof createOperationTracker>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} tracker={tracker} />
    </I18nextProvider>,
  );
}

it("keeps the commit running in the global tracker after the wizard unmounts", async () => {
  const user = userEvent.setup();
  const tracker = createOperationTracker();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  let release!: (results: Awaited<ReturnType<typeof facade.commitImport>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof facade.commitImport>>>((resolve) => {
    release = resolve;
  });
  facade.commitImport = vi.fn(async (plan, _actions, onProgress) => {
    onProgress?.({ candidateId: plan.candidates[0]?.id ?? "", completed: 1, total: plan.candidates.length });
    return pending;
  });
  const { unmount } = await renderWithTracker(facade, tracker);

  await user.type(screen.getByLabelText("来源"), "C:/incoming");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("button", { name: "全选可导入候选" }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));

  // 提交期间离开页面（卸载向导）
  unmount();
  await act(async () => {
    release([
      { candidateId: "c1", action: "copy", status: "succeeded", message: "ok" },
      { candidateId: "c2", action: "skip", status: "skipped", message: "dup" },
    ]);
  });

  const [operation] = tracker.getSnapshot();
  expect(operation.kind).toBe("import");
  expect(operation.status).toBe("completed");
  expect(operation.completed).toBe(operation.total);
  expect(operation.resultSummary).toEqual({ succeeded: 1, failed: 0, skipped: 1 });
});

it("shows candidate progress while commit is in flight", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  let release!: (results: Awaited<ReturnType<typeof facade.commitImport>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof facade.commitImport>>>((resolve) => {
    release = resolve;
  });
  facade.commitImport = vi.fn(async (plan, _actions, onProgress) => {
    onProgress?.({ candidateId: plan.candidates[0]?.id ?? "", completed: 0, total: plan.candidates.length });
    return pending;
  });
  await renderWizard(facade);

  await user.type(screen.getByLabelText("来源"), "C:/incoming");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("button", { name: "全选可导入候选" }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));

  expect(await screen.findByText("正在提交导入（已完成 0/2，当前：safe-pdf）")).toBeVisible();
  await act(async () => {
    release([]);
  });
});
