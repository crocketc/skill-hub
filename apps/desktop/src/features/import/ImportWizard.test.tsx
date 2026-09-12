import { act, screen, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { AppNotificationsProvider } from "../../ui/notifications";
import { createOperationTracker } from "../../platform/operationTracker";
import { clearSessionSelectedSources } from "./sessionSources";
import { createMockImportFacade, unavailableImportFacade, type ImportPlan, type ImportResult } from "./api";
import { ImportWizard } from "./ImportWizard";

/** 通知接线测试壳：向导消费全局通知服务（AppShell 同款 Provider + Router）。 */
function TestShell({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AppNotificationsProvider>{children}</AppNotificationsProvider>
    </MemoryRouter>
  );
}

async function renderWizard(facade = createMockImportFacade({ scenario: "safe-local" }), tracker?: ReturnType<typeof createOperationTracker>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
        <ImportWizard facade={facade} tracker={tracker} />
      </I18nextProvider>
    </TestShell>,
  );
  return facade;
}

async function renderGuidedWizard(facade = createMockImportFacade({ scenario: "safe-local" }), variant?: "onboarding" | "standard") {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
        <ImportWizard
          facade={facade}
          initialSources={["C:/codex/skills", "C:/claude/skills"]}
          initialSourceText="C:/codex/skills"
          variant={variant}
        />
      </I18nextProvider>
    </TestShell>,
  );
  return facade;
}

// M-29：会话内已选来源是模块级单例；每个用例从干净状态开始。
beforeEach(() => {
  clearSessionSelectedSources();
});

it("exposes the unified step rail and keeps the primary action in a stable footer", async () => {
  const user = userEvent.setup();
  await renderWizard();

  const rail = screen.getByRole("list", { name: "导入步骤" });
  const steps = within(rail).getAllByRole("listitem");
  expect(steps).toHaveLength(4);
  expect(steps[0]).toHaveAttribute("aria-current", "step");
  expect(steps[0]).toHaveTextContent("选择来源");
  expect(steps[3]).toHaveTextContent("导入完成");

  const parse = screen.getByRole("button", { name: "解析来源" });
  const footerBefore = parse.closest("footer");
  expect(footerBefore).not.toBeNull();

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(parse);
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));

  const railAfter = screen.getByRole("list", { name: "导入步骤" });
  const stepsAfter = within(railAfter).getAllByRole("listitem");
  expect(stepsAfter[0]).toHaveTextContent("已完成");
  expect(stepsAfter[1]).toHaveAttribute("aria-current", "step");

  // 主操作换成了"分析冲突"，但仍必须挂在同一个 footer 操作区内。
  const analyze = screen.getByRole("button", { name: "分析冲突" });
  const footerAfter = analyze.closest("footer");
  expect(footerAfter).not.toBeNull();
  expect(footerAfter).toBe(footerBefore);
});

it("reports a per-source scan failure with its own reason and single-source retry", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const healthyAcquire = facade.acquireCandidates.bind(facade);
  facade.acquireCandidates = vi.fn(async (source, signal) => {
    if (source.displayTarget === "C:/broken/skills") {
      throw new Error("simulated per-source failure");
    }
    return healthyAcquire(source, signal);
  });
  await renderGuidedWizard(facade);

  // 追加一个必然失败的来源目录。
  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/broken/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));
  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));

  // 门槛页：成功来源照常显示候选数；失败来源显示自己的原因，不影响其他目录。
  expect(await screen.findByText("C:/codex/skills：2 个候选")).toBeVisible();
  expect(screen.getByText("C:/claude/skills：2 个候选")).toBeVisible();
  expect(screen.getByText(/C:\/broken\/skills：simulated per-source failure/)).toBeVisible();
  // 其他目录的候选仍可继续，不被失败目录拖累。
  expect(screen.getByRole("button", { name: "继续选择候选" })).toBeEnabled();

  // 修复后单独重试：只重新扫描失败的那一个目录。
  facade.acquireCandidates = healthyAcquire;
  await user.click(screen.getByRole("button", { name: "重新扫描 C:/broken/skills" }));

  expect(await screen.findByText("C:/broken/skills：2 个候选")).toBeVisible();
  expect(screen.queryByText(/simulated per-source failure/)).not.toBeInTheDocument();
  // 初次扫描中失败目录在进入 mock 记录前即抛错；重试恰好补上一次读取。
  expect(facade.calls.acquiredSources).toEqual([
    "C:/codex/skills",
    "C:/claude/skills",
    "C:/broken/skills",
  ]);
});

it("keeps the gate honest when every source fails and offers per-source retry", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.acquireCandidates = vi.fn(async () => {
    throw new Error("simulated total failure");
  });
  await renderWizard(facade);

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));

  expect(await screen.findByText(/C:\/skills\/pdf：simulated total failure/)).toBeVisible();
  expect(screen.getByRole("button", { name: "继续选择候选" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "重新扫描 C:/skills/pdf" })).toBeEnabled();
});

it("keeps the wizard recoverable when the host facade is unavailable", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard facade={unavailableImportFacade} />
    </I18nextProvider>
    </TestShell>,
  );

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));

  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
});

it("offers the cancelled state its own message and footer retry without merging with failures", async () => {
  const user = userEvent.setup();
  await renderWizard(createMockImportFacade({ scenario: "cancelled" }));

  await user.type(screen.getByLabelText("来源"), "C:\\Skills\\pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "取消获取" }));

  expect(screen.getByText("获取已取消，来源内容仍然保留。")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const retry = screen.getByRole("button", { name: "重试获取" });
  expect(retry.closest("footer")).not.toBeNull();
  expect(screen.getByLabelText("来源")).toHaveValue("C:\\Skills\\pdf");
});

it("returns a partially failed summary to a fresh run through the footer retry", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.commitImport = vi.fn(async (): Promise<ImportResult[]> => [
    { candidateId: "safe-pdf", action: "copy", status: "succeeded", message: "已导入" },
    { candidateId: "safe-browser", action: "copy", status: "failed", message: "写入失败" },
  ]);
  await renderWizard(facade);

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("button", { name: "全选可导入候选" }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));

  expect(await screen.findByText("写入失败")).toBeVisible();
  const retry = screen.getByRole("button", { name: "重试" });
  expect(retry.closest("footer")).not.toBeNull();
  await user.click(retry);

  // 恢复路径：摘要重试回到来源步骤重新发起，绝不静默重复提交。
  expect(await screen.findByRole("button", { name: "解析来源" })).toBeVisible();
  expect(facade.commitImport).toHaveBeenCalledTimes(1);
});

it("keeps keyboard focus on the flow heading across phase changes", async () => {
  const user = userEvent.setup();
  await renderWizard();

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  // 阶段切换时原主操作卸载；焦点必须落回稳定目标，不能丢失到 body。
  await screen.findByRole("button", { name: "继续选择候选" });
  expect(document.activeElement).toBe(document.body);

  await user.click(screen.getByRole("button", { name: "继续选择候选" }));
  expect(screen.getByRole("heading", { name: "导入 Skill" })).toHaveFocus();
});

it("announces phase progress through the persistent status region", async () => {
  const user = userEvent.setup();
  await renderWizard();

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));

  expect(await screen.findByText("候选项已准备好")).toBeVisible();
});

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

it("requires a candidate selection before analyzing", async () => {
  const user = userEvent.setup();
  await renderWizard();

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));

  const analyze = screen.getByRole("button", { name: "分析冲突" });
  expect(analyze).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  expect(analyze).toBeEnabled();
});

it("keeps commit disabled until every required conflict has an explicit decision", async () => {
  const user = userEvent.setup();
  await renderWizard(createMockImportFacade({ scenario: "agent-owned-partial" }));

  await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  const commit = await screen.findByRole("button", { name: "提交导入" });
  expect(commit).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: "保留当前位置并纳入管理" }));
  expect(commit).toBeEnabled();
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

it("removes one scanned source at the gate and keeps the other sources' candidates", async () => {
  const user = userEvent.setup();
  const facade = await renderGuidedWizard();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByText("找到 4 个候选项，请先审阅列表。")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "移除来源 C:/codex/skills" }));

  expect(await screen.findByText("找到 2 个候选项，请先审阅列表。")).toBeVisible();
  // 门槛页不再展示被移除来源的计数行。
  // 剩余来源的候选行仍在（文本含按钮文案，用子串匹配）。
  const claudeRow = await screen.findByText((_, element) =>
    element?.tagName === "LI" && element.textContent?.includes("C:/claude/skills：2 个候选") === true,
  );
  expect(claudeRow).toBeVisible();
  expect(screen.queryByText((_, element) =>
    element?.tagName === "LI" && element.textContent?.includes("C:/codex/skills：2 个候选") === true,
  )).toBeNull();
  expect(facade.calls.acquiredSources).toEqual(["C:/codex/skills", "C:/claude/skills"]);
});

it("removes all acquired sources from the candidate gate in one action", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByText("找到 4 个候选项，请先审阅列表。")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "移除全部来源" }));

  expect(screen.getByRole("heading", { name: "从哪里查找 Skill？" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "继续选择候选" })).not.toBeInTheDocument();
});

it("adds a manual directory alongside scanned sources for mixed import", async () => {
  const user = userEvent.setup();
  const facade = await renderGuidedWizard();

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/windsurf/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  expect(await screen.findByRole("button", { name: "添加到已选来源" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual([
    "C:/codex/skills",
    "C:/claude/skills",
    "C:/windsurf/skills",
  ]);
});

it("shows a manually added directory in the selected list immediately without scanning", async () => {
  const user = userEvent.setup();
  const facade = await renderGuidedWizard();

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/windsurf/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  // 无需任何扫描动作：已选来源立即出现，并带明确的"未扫描"状态。
  const list = screen.getByRole("list", { name: "已选来源" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(within(items[2]).getByText("C:/windsurf/skills")).toBeVisible();
  expect(within(items[2]).getByText("未扫描")).toBeVisible();
  // 既有来源保持已选状态（会话内可见），未扫描的来源不会被隐藏。
  expect(within(items[0]).getByText("C:/codex/skills")).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual([]);
});

it("keeps a selected source visible with its scan result after returning to the source step", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  // 返回上一步：已选来源与每个目录的候选数仍然可见。
  await user.click(screen.getByRole("button", { name: "上一步" }));

  const list = screen.getByRole("list", { name: "已选来源" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByText("2 个候选")).toBeVisible();
  expect(within(items[1]).getByText("2 个候选")).toBeVisible();
});

it("deduplicates a repeated directory and focuses the existing entry", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/codex/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  // 去重：不新增重复条目；高亮/聚焦已有条目。
  const list = screen.getByRole("list", { name: "已选来源" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  const codexItem = within(list).getByText("C:/codex/skills").closest("li");
  expect(document.activeElement).toBe(codexItem);
});

it("deduplicates case-variant directories to one entry on Windows paths", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/codex/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  // Windows 路径大小写不敏感：仅大小写不同的目录必须并成一条。
  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "c:/CODEX/Skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  const list = screen.getByRole("list", { name: "已选来源" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("C:/codex/skills")).toBeVisible();
});

it("removes selected sources individually, in bulk, and all at once from the list", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/windsurf/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  // 逐条删除。
  await user.click(screen.getByRole("button", { name: "移除已选来源 C:/codex/skills" }));
  const list = screen.getByRole("list", { name: "已选来源" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);

  // 多选删除。
  await user.click(screen.getByRole("checkbox", { name: "选中来源 C:/claude/skills 以便批量删除" }));
  await user.click(screen.getByRole("checkbox", { name: "选中来源 C:/windsurf/skills 以便批量删除" }));
  await user.click(screen.getByRole("button", { name: "删除所选（2）" }));
  expect(screen.queryByRole("list", { name: "已选来源" })).not.toBeInTheDocument();

  // 清空后重新添加一个来源，再全部清空。
  await user.type(screen.getByLabelText("来源"), "C:/solo/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));
  expect(screen.getByRole("list", { name: "已选来源" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "全部清空" }));
  expect(screen.queryByRole("list", { name: "已选来源" })).not.toBeInTheDocument();
});

it("restores the selected sources when the wizard reopens in the same session", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { unmount } = render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} initialSources={["C:/codex/skills"]} />
    </I18nextProvider>
    </TestShell>,
  );
  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/extra/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));
  unmount();

  // 取消/关闭向导后再次进入：已选来源保留（会话内）；落库仍只发生在提交。
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} />
    </I18nextProvider>
    </TestShell>,
  );
  const list = screen.getByRole("list", { name: "已选来源" });
  expect(within(list).getByText("C:/codex/skills")).toBeVisible();
  expect(within(list).getByText("C:/extra/skills")).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual([]);
});

it("keeps onboarding selections local instead of restoring them from the session store", async () => {
  const user = userEvent.setup();
  const picker = { pickDirectory: vi.fn(async () => "C:/picked/skills") };
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const first = render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard
        directoryPicker={picker}
        facade={facade}
        initialSources={["C:/codex/skills"]}
        variant="onboarding"
      />
    </I18nextProvider>
    </TestShell>,
  );
  await user.click(screen.getByRole("button", { name: "选择本地目录" }));
  first.unmount();

  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} initialSources={["C:/codex/skills"]} variant="onboarding" />
    </I18nextProvider>
    </TestShell>,
  );
  const list = screen.getByRole("list", { name: "已选来源" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(1);
  expect(within(items[0]).getByText("C:/codex/skills")).toBeVisible();
});

it("keeps the onboarding import to reading the selected directory candidates", async () => {
  const user = userEvent.setup();
  const facade = await renderGuidedWizard(undefined, "onboarding");

  // 初始化导入不再提供“添加到已选来源”；手动输入文本不会变成第二个操作。
  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/windsurf/skills");
  expect(screen.queryByRole("button", { name: "添加到已选来源" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual(["C:/codex/skills", "C:/claude/skills"]);
});

it("adds the picked local directory to the onboarding selection without the manual add action", async () => {
  const user = userEvent.setup();
  const picker = { pickDirectory: vi.fn(async () => "C:/picked/skills") };
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard
        directoryPicker={picker}
        facade={facade}
        initialSources={["C:/codex/skills", "C:/claude/skills"]}
        initialSourceText=""
        variant="onboarding"
      />
    </I18nextProvider>
    </TestShell>,
  );

  await user.click(screen.getByRole("button", { name: "选择本地目录" }));
  expect(screen.queryByRole("button", { name: "添加到已选来源" })).not.toBeInTheDocument();

  // 手动选择的目录自动进入已选来源，主操作直接读取全部已选目录。
  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual([
    "C:/codex/skills",
    "C:/claude/skills",
    "C:/picked/skills",
  ]);
});

it("keeps the acquire action available and shows per-source counts when the source box is empty", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} initialSources={["C:/codex/skills", "C:/claude/skills"]} initialSourceText="" />
    </I18nextProvider>
    </TestShell>,
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
  const firstSource = "\\\\?\\C:\\Users\\demo\\.claude\\skills";
  const secondSource = "\\\\?\\C:\\Users\\demo\\.codex\\skills";
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard
        facade={facade}
        initialSourceText={firstSource}
        initialSources={[firstSource, secondSource]}
      />
    </I18nextProvider>
    </TestShell>,
  );

  expect(screen.getByRole("textbox", { name: "来源" })).toHaveValue("C:\\Users\\demo\\.claude\\skills");
  expect(screen.getByRole("checkbox", { name: "C:\\Users\\demo\\.claude\\skills" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "C:\\Users\\demo\\.codex\\skills" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));

  expect(facade.calls.acquiredSources).toEqual([
    "C:\\Users\\demo\\.claude\\skills",
    "C:\\Users\\demo\\.codex\\skills",
  ]);
});

it("fills the source from the native directory picker", async () => {
  const user = userEvent.setup();
  const picker = { pickDirectory: vi.fn(async () => "\\\\?\\C:\\picked\\skills") };
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard directoryPicker={picker} />
    </I18nextProvider>
    </TestShell>,
  );

  await user.click(screen.getByRole("button", { name: "选择本地目录" }));

  expect(await screen.findByDisplayValue("C:\\picked\\skills")).toBeVisible();
  expect(picker.pickDirectory).toHaveBeenCalledOnce();
});

it("adds a directory from the native picker without clearing selected scan sources", async () => {
  const user = userEvent.setup();
  const picker = { pickDirectory: vi.fn(async () => "C:/picked/skills") };
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard
        directoryPicker={picker}
        facade={facade}
        initialSources={["C:/codex/skills", "C:/claude/skills"]}
      />
    </I18nextProvider>
    </TestShell>,
  );

  await user.click(screen.getByRole("button", { name: "选择本地目录" }));
  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));

  expect(facade.calls.acquiredSources).toEqual([
    "C:/codex/skills",
    "C:/claude/skills",
    "C:/picked/skills",
  ]);
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
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} tracker={tracker} />
    </I18nextProvider>
    </TestShell>,
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

it("refuses to commit while another import is still running", async () => {
  const user = userEvent.setup();
  const tracker = createOperationTracker();
  tracker.begin({ kind: "import", label: "后台导入进行中", total: 3 });
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.commitImport = vi.fn(async () => []);
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} tracker={tracker} />
    </I18nextProvider>
    </TestShell>,
  );

  await user.type(screen.getByLabelText("来源"), "C:/incoming");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("button", { name: "全选可导入候选" }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  const commitButton = await screen.findByRole("button", { name: "提交导入" });
  expect(commitButton).toBeDisabled();
  expect(screen.getByText(/另一个导入正在进行，完成后才能提交本次导入/)).toBeVisible();

  await user.click(commitButton);

  expect(facade.commitImport).not.toHaveBeenCalled();
  expect(tracker.getSnapshot()).toHaveLength(1);
  expect(tracker.getSnapshot()[0].status).toBe("running");
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

describe("global notifications for import outcomes", () => {
  async function reachCommit(facade: ReturnType<typeof createMockImportFacade>) {
    const user = userEvent.setup();
    await renderWizard(facade);
    await user.type(screen.getByLabelText("来源"), "C:/incoming");
    await user.click(screen.getByRole("button", { name: "解析来源" }));
    await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
    await user.click(screen.getByRole("button", { name: "全选可导入候选" }));
    await user.click(screen.getByRole("button", { name: "分析冲突" }));
    await screen.findByRole("button", { name: "提交导入" });
    return user;
  }

  it("notifies success with a view-library action when an import commits", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const user = await reachCommit(facade);
    await user.click(screen.getByRole("button", { name: "提交导入" }));

    // 全局通知：成功 toast 汇总结果并带"查看库中 Skill"跳转。
    expect(await screen.findByText("导入已完成")).toBeVisible();
    const action = screen.getByRole("link", { name: "查看库中 Skill" });
    expect(action).toHaveAttribute("href", "/library");
    // 逐对象结果详情仍保留在流程页（摘要），不进通知。
    expect(screen.getByRole("heading", { name: "导入结果" })).toBeVisible();
    expect(screen.getByText("成功 2")).toBeVisible();
  });

  it("marks a finished import with per-object failures as a warning notice", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.commitImport = vi.fn(async (): Promise<ImportResult[]> => [
      { candidateId: "safe-pdf", action: "copy", status: "succeeded", message: "已导入" },
      { candidateId: "safe-browser", action: "copy", status: "failed", message: "写入失败" },
    ]);
    const user = await reachCommit(facade);
    await user.click(screen.getByRole("button", { name: "提交导入" }));

    const notice = await screen.findByTestId("notice-warning");
    expect(within(notice).getByText("导入已完成")).toBeVisible();
    expect(within(notice).getByText(/失败 1/)).toBeVisible();
  });

  it("notifies a failed submission while the failure detail stays in the flow page", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.commitImport = vi.fn(async () => {
      throw new Error("simulated commit failure");
    });
    const user = await reachCommit(facade);
    await user.click(screen.getByRole("button", { name: "提交导入" }));

    const notice = await screen.findByTestId("notice-danger");
    expect(within(notice).getByText("导入提交失败")).toBeVisible();
    expect(within(notice).getByText(/simulated commit failure/)).toBeVisible();
    // 失败详情同时留在流程页（失败态告警）。
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(2);
  });

  it("notifies when the user cancels the import flow", async () => {
    const user = userEvent.setup();
    await renderWizard(createMockImportFacade({ scenario: "cancelled" }));

    await user.type(screen.getByLabelText("来源"), "C:\\Skills\\pdf");
    await user.click(screen.getByRole("button", { name: "解析来源" }));
    await user.click(await screen.findByRole("button", { name: "取消获取" }));

    expect(await screen.findByText("导入流程已取消")).toBeVisible();
    expect(document.querySelector('[data-testid="notice-info"]')).not.toBeNull();
  });
});

describe("AI import pre-check", () => {
  async function reachConflicts(facade: ReturnType<typeof createMockImportFacade>) {
    const user = userEvent.setup();
    await renderWizard(facade);
    await user.type(screen.getByLabelText("来源"), "C:\\skills\\pdf");
    await user.click(screen.getByRole("button", { name: "解析来源" }));
    await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
    await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
    await user.click(screen.getByRole("button", { name: "分析冲突" }));
    await screen.findByRole("button", { name: "提交导入" });
    return user;
  }

  it("shows the optional pre-check scope and lets users skip it", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.runAiPreChecks = vi.fn();
    await reachConflicts(facade);

    expect(screen.getByRole("heading", { name: "AI 预检（可选）" })).toBeVisible();
    expect(screen.getByText("本次预检对象数量：1")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "跳过预检" }));
    expect(
      screen.getByText(/已跳过 AI 预检；基础检查与确定性门照常生效/),
    ).toBeVisible();
  });

  it("renders the per-object report after the pre-check runs", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.runAiPreChecks = vi.fn(async (plan: ImportPlan) => ({
      model: "test-model",
      provider: "test",
      requested: plan.candidates.length,
      outcomes: plan.candidates.map((candidate) => ({
        candidateId: candidate.id,
        failureCode: null,
        fileCount: 3,
        findingCount: 0,
        state: "passed" as const,
      })),
    }));
    const user = await reachConflicts(facade);

    await user.click(screen.getByRole("button", { name: "运行 AI 预检" }));

    expect(
      await screen.findByText("服务 test · 模型 test-model · 预检对象 1 个"),
    ).toBeVisible();
    expect(screen.getByText(/发现 0 项（3 个文件）/)).toBeVisible();
    expect(screen.queryByText(/已跳过 AI 预检/)).not.toBeInTheDocument();
  });

  it("reports a failed object with a readable reason without losing the rest", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.runAiPreChecks = vi.fn(async (plan: ImportPlan) => ({
      model: "test-model",
      provider: "test",
      requested: plan.candidates.length,
      outcomes: [
        {
          candidateId: plan.candidates[0].id,
          failureCode: "llm.request_timeout",
          fileCount: 2,
          findingCount: 0,
          state: "failed" as const,
        },
      ],
    }));
    const user = await reachConflicts(facade);

    await user.click(screen.getByRole("button", { name: "运行 AI 预检" }));

    expect(
      await screen.findByText(
        /预检失败，其他对象不受影响：连接模型服务超时，请检查网络后重试。/,
      ),
    ).toBeVisible();
    expect(screen.getByText("失败")).toBeVisible();
    // 裸错误码不允许出现在用户界面上。
    expect(screen.queryByText(/llm\.request_timeout/)).not.toBeInTheDocument();
  });

  it("explains that the deterministic gates survive a failed AI pre-check", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.runAiPreChecks = vi.fn(async () => {
      throw { code: "llm.not_configured", severity: "error", params: {}, actions: [] };
    });
    const user = await reachConflicts(facade);

    await user.click(screen.getByRole("button", { name: "运行 AI 预检" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("尚未配置可用的 LLM 供应商，请先添加并启用供应商。");
    expect(
      screen.getByText("AI 预检未完成：以上确定性检查结果不受影响，可以直接继续导入。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "提交导入" })).toBeVisible();
  });

  it("renders unknown import failures with the generic import copy instead of the key name", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.acquireCandidates = vi.fn(async () => {
      throw { code: "host.weird_failure", severity: "error", params: {}, actions: [] };
    });
    await renderWizard(facade);

    await user.type(screen.getByLabelText("来源"), "C:/skills/pdf");
    await user.click(screen.getByRole("button", { name: "解析来源" }));

    // M-29：未知失败码按目录落到来源行，仍以可读文案呈现，绝不出裸码。
    expect(
      await screen.findByText(/C:\/skills\/pdf：导入步骤未能完成（host\.weird_failure）。/),
    ).toBeVisible();
    expect(screen.queryByText(/host\.weird_failure：/)).not.toBeInTheDocument();
  });

  it("keeps the wizard importable when the facade cannot run pre-checks", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    delete (facade as { runAiPreChecks?: unknown }).runAiPreChecks;
    await reachConflicts(facade);

    expect(
      screen.getByText("当前环境未提供 AI 预检能力，可直接继续导入。"),
    ).toBeVisible();
  });
});
