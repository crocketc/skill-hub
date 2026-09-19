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
import { clearWizardSession } from "./wizardSession";
import { createMockImportFacade, unavailableImportFacade, type ImportAction, type ImportCandidate, type ImportPlan, type ImportProgress, type ImportResult, type SourceDescriptor } from "./api";
import type { ImportGovernanceDecision } from "../relationshipGovernance/relationshipGovernance";
import type { ImportGovernanceGroup } from "../../api/bindings";
import type { DirectoryPicker } from "../../platform/directoryPicker";
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

async function renderGuidedWizard(
  facade = createMockImportFacade({ scenario: "safe-local" }),
  variant?: "onboarding" | "standard",
  directoryPicker?: DirectoryPicker,
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
        <ImportWizard
          facade={facade}
          directoryPicker={directoryPicker}
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
  clearWizardSession();
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

it("automatically previews onboarding sources and continues directly to candidates", async () => {
  const facade = createMockImportFacade({ scenario: "safe-local" });
  await renderGuidedWizard(facade, "onboarding");

  const sourceList = await screen.findByRole("list", { name: "已选来源" });
  expect(await within(sourceList).findAllByText("2 个候选")).toHaveLength(2);
  expect(facade.calls.acquiredSources).toEqual(
    expect.arrayContaining(["C:/codex/skills", "C:/claude/skills"]),
  );
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "读取已选目录候选" })).not.toBeInTheDocument();
});

it("disables the onboarding continuation while default sources are resolving", async () => {
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.acquireCandidates = vi.fn(() => new Promise<ImportCandidate[]>(() => undefined));
  await renderGuidedWizard(facade, "onboarding");

  const sourceList = await screen.findByRole("list", { name: "已选来源" });
  expect(await within(sourceList).findAllByText("解析中")).toHaveLength(2);
  expect(await screen.findByRole("button", { name: "正在解析…" })).toBeDisabled();
});

it("returns the onboarding footer to an actionable idle state when the source text is edited after the auto-preview", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  await renderGuidedWizard(facade, "onboarding");

  // 自动预览完成：门槛继续可用。
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeEnabled();

  // 编辑来源输入框：陈旧预览状态作废，页脚必须回到可操作的空闲态，
  // 绝不永久停留在"正在解析…"（E2E 发现的页脚卡死）。
  await user.type(screen.getByLabelText("来源"), "-edited");
  const acquire = screen.getByRole("button", { name: "读取已选目录候选" });
  expect(acquire).toBeEnabled();

  // 显式重新获取后流程照常前进（0 候选不放行的门不受影响）。
  await user.click(acquire);
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeEnabled();
});

it("discards in-flight onboarding previews when the source text is edited and stays actionable", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const healthyAcquire = facade.acquireCandidates.bind(facade);
  const resolvers: Array<(candidates: ImportCandidate[]) => void> = [];
  facade.acquireCandidates = vi.fn(
    () => new Promise<ImportCandidate[]>((resolve) => {
      resolvers.push(resolve);
    }),
  );
  await renderGuidedWizard(facade, "onboarding");

  // 预览在途：页脚如实显示解析中并禁用。
  expect(await screen.findByRole("button", { name: "正在解析…" })).toBeDisabled();

  // 在途时编辑来源：预览会话作废，页脚回到可操作的空闲态。
  await user.type(screen.getByLabelText("来源"), "-edited");
  const acquire = screen.getByRole("button", { name: "读取已选目录候选" });
  expect(acquire).toBeEnabled();

  // 迟到的预览完成被请求序号守卫丢弃：不得借陈旧终结把流程拖回门槛页。
  await act(async () => {
    for (const resolve of resolvers.splice(0)) resolve([]);
  });
  expect(screen.getByRole("button", { name: "读取已选目录候选" })).toBeEnabled();

  // 用户显式重新获取后流程前进。
  facade.acquireCandidates = healthyAcquire;
  await user.click(acquire);
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeEnabled();
});

it("keeps the onboarding footer actionable after repeated quick edits of the source text", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  await renderGuidedWizard(facade, "onboarding");

  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeEnabled();

  // 连续两次快速编辑：状态转移确定，页脚保持可操作空闲态。
  await user.type(screen.getByLabelText("来源"), "-a");
  await user.type(screen.getByLabelText("来源"), "-b");
  const acquire = screen.getByRole("button", { name: "读取已选目录候选" });
  expect(acquire).toBeEnabled();

  await user.click(acquire);
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeEnabled();
});

it("keeps the onboarding footer actionable when every auto-previewed source is deselected mid-preview", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.acquireCandidates = vi.fn(() => new Promise<ImportCandidate[]>(() => undefined));
  await renderGuidedWizard(facade, "onboarding");

  // 预览在途。
  expect(await screen.findByRole("button", { name: "正在解析…" })).toBeDisabled();

  // 在途时取消勾选全部初始化来源：预览会话作废，页脚不得永久停在"正在解析…"。
  await user.click(screen.getByRole("checkbox", { name: "C:/codex/skills" }));
  await user.click(screen.getByRole("checkbox", { name: "C:/claude/skills" }));
  expect(screen.getByRole("button", { name: "解析来源" })).toBeEnabled();
});

it("scans pre-selected sources automatically in the standard wizard and on re-check", async () => {
  // DEV-13：标准向导挂载时已勾选来源必须立即后台解析（与文案「Skill 数量
  // 会在后台自动解析」一致），取消再勾选也要重新解析，用户无需再点
  // 「读取已选目录候选」。
  const user = userEvent.setup();
  const acquire = vi.fn(async () => []);
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.acquireCandidates = acquire;
  await renderGuidedWizard(facade, "standard");

  // 初始来源已勾选：挂载即解析（mock 即时完成，直接断言候选数与调用）。
  expect((await screen.findAllByText("0 个候选")).length).toBeGreaterThanOrEqual(2);
  expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(2);

  // 取消再勾选：重新解析该来源。
  const claudeCheckbox = screen.getByRole("checkbox", { name: "C:/claude/skills" });
  const callsBefore = acquire.mock.calls.length;
  await user.click(claudeCheckbox);
  await user.click(claudeCheckbox);
  expect((await screen.findAllByText("0 个候选")).length).toBeGreaterThanOrEqual(1);
  expect(acquire.mock.calls.length).toBeGreaterThan(callsBefore);
});

it("drops the stale preview completion when a toggled source restarts its preview mid-flight", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const resolvers: Array<(candidates: ImportCandidate[]) => void> = [];
  facade.acquireCandidates = vi.fn(
    () => new Promise<ImportCandidate[]>((resolve) => {
      resolvers.push(resolve);
    }),
  );
  await renderGuidedWizard(facade, "onboarding");

  // 两个初始来源的预览都在途（前两个 resolver）。
  expect(await screen.findByRole("button", { name: "正在解析…" })).toBeDisabled();

  // 取消再勾选 C:/codex/skills：旧预览被取代，新的在途预览接管该来源。
  await user.click(screen.getByRole("checkbox", { name: "C:/codex/skills" }));
  await user.click(screen.getByRole("checkbox", { name: "C:/codex/skills" }));
  expect(resolvers.length).toBe(3);

  // 旧预览迟到完成：不得借旧请求序号清除在途标记或触发终结。
  await act(async () => {
    resolvers.splice(0, 2).forEach((resolve) => resolve([]));
  });
  expect(screen.queryByRole("button", { name: "继续选择候选" })).not.toBeInTheDocument();

  // 新预览完成后按真实结果终结。
  await act(async () => {
    resolvers.splice(0).forEach((resolve) => resolve([]));
  });
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
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

  // 统一来源确认列表：成功来源显示候选数；失败来源显示自己的原因，不影响其他目录。
  const sourceList = screen.getByRole("list", { name: "已选来源" });
  expect(await within(sourceList).findAllByText("2 个候选")).toHaveLength(2);
  expect(within(sourceList).getAllByText("2 个候选")).toHaveLength(2);
  expect(within(sourceList).getByText("simulated per-source failure")).toBeVisible();
  // 其他目录的候选仍可继续，不被失败目录拖累。
  expect(screen.getByRole("button", { name: "继续选择候选" })).toBeEnabled();

  // 修复后单独重试：只重新扫描失败的那一个目录。
  facade.acquireCandidates = healthyAcquire;
  await user.click(screen.getByRole("button", { name: "重新扫描 C:/broken/skills" }));

  expect(await within(sourceList).findAllByText("2 个候选")).toHaveLength(3);
  expect(within(sourceList).queryByText("simulated per-source failure")).not.toBeInTheDocument();
  expect(within(sourceList).getAllByText("2 个候选")).toHaveLength(3);
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

  const sourceList = await screen.findByRole("list", { name: "已选来源" });
  expect(await within(sourceList).findByText("simulated total failure")).toBeVisible();
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

it("leads the governance and conflicts steps with a readable summary strip (DEV-20)", async () => {
  const user = userEvent.setup();
  await renderWizard(createMockImportFacade({ scenario: "conflict-required" }));

  await user.type(screen.getByLabelText("来源"), "C:/incoming");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  // 冲突步首屏：结论区先行播报冲突总数与必须决策数。
  const conflictsSummary = await screen.findByRole("status", { name: "本次导入的冲突结论" });
  expect(conflictsSummary).toBeVisible();
  expect(conflictsSummary).toHaveTextContent(/共发现 1 处冲突/);
  expect(conflictsSummary).toHaveTextContent(/1 处必须由你选择/);
  // 决策控件在结论区之后仍然可达。
  expect(await screen.findByRole("radio", { name: "独立导入" })).toBeVisible();
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
  expect(screen.getByText("候选项已准备好")).toBeVisible();
});

it("removes one source from the unified confirmation list and keeps the other source", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByText("候选项已准备好")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "移除已选来源 C:/codex/skills" }));

  expect(await screen.findByText("候选项已准备好")).toBeVisible();
  const sourceList = screen.getByRole("list", { name: "已选来源" });
  expect(within(sourceList).getByText("C:\\claude\\skills")).toBeVisible();
  expect(within(sourceList).getByRole("checkbox", { name: "C:/codex/skills" })).not.toBeChecked();
});

it("removes all selected sources from the unified confirmation list in one action", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByText("候选项已准备好")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "全部清空" }));

  expect(screen.getByRole("heading", { name: "从哪里查找 Skill？" })).toBeVisible();
  expect(screen.getByRole("list", { name: "已选来源" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "C:/codex/skills" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "C:/claude/skills" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "解析来源" })).toBeEnabled();
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
  // DEV-13：挂载即自动解析已选来源（codex/claude 各一次），手动目录在
  // 添加时解析一次；随后批量读取因输入编辑作废过预览缓存而重扫已选来源。
  const acquired = facade.calls.acquiredSources;
  expect(acquired.filter((source) => source === "C:/windsurf/skills")).toHaveLength(1);
  expect(acquired.filter((source) => source === "C:/codex/skills")).toHaveLength(2);
  expect(acquired.filter((source) => source === "C:/claude/skills")).toHaveLength(2);
});

it("shows a manually added directory in the selected list while silently previewing", async () => {
  const user = userEvent.setup();
  const facade = await renderGuidedWizard();

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/windsurf/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  // 选中后立即出现，并自动进入后台数量解析。
  const list = screen.getByRole("list", { name: "已选来源" });
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(within(items[2]).getByText("C:\\windsurf\\skills")).toBeVisible();
  expect(await within(items[2]).findByText("2 个候选")).toBeVisible();
  // 既有来源保持已选状态（会话内可见）。
  expect(within(items[0]).getByText("C:\\codex\\skills")).toBeVisible();
  expect(facade.calls.acquiredSources).toContain("C:/windsurf/skills");
});

it("silently previews a newly selected source and reports its skill count", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.parseSource = vi.fn(async (source): Promise<SourceDescriptor> => ({
    displayTarget: source,
    executesCommand: false,
    input: source,
    kind: "local_path" as const,
  }));
  facade.acquireCandidates = vi.fn(async (source): Promise<ImportCandidate[]> => [
    {
      id: "preview-only",
      name: "Preview only",
      source,
      path: "C:/claude/skills/preview-only",
      ownership: "unknown",
      basicCheck: "not_checked",
    },
  ]);
  await renderGuidedWizard(facade);

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/new/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  expect(await screen.findByText("1 个候选")).toBeVisible();
  expect(screen.getByRole("list", { name: "已选来源" })).toBeVisible();
  expect(screen.getByRole("button", { name: "读取已选目录候选" })).toBeEnabled();
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
  const codexItem = within(list).getByText("C:\\codex\\skills").closest("li");
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
  expect(within(list).getByText("C:\\codex\\skills")).toBeVisible();
});

it("deduplicates a picked directory against a case-variant selected source", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard(undefined, undefined, {
    pickDirectory: async () => "c:/CODEX/Skills",
  });

  // 与手动添加一致：本机选取仅大小写不同的 Windows 目录时并入已有条目并聚焦，
  // 不产生重复来源。
  await user.click(screen.getByRole("button", { name: "选择本地目录" }));

  const list = screen.getByRole("list", { name: "已选来源" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("C:\\codex\\skills")).toBeVisible();
  expect(document.activeElement).toBe(
    within(list).getByText("C:\\codex\\skills").closest("li"),
  );
});

it("keeps POSIX case-variant directories as distinct sources", async () => {
  const user = userEvent.setup();
  await renderGuidedWizard();

  // macOS 卷可能被格式化为大小写敏感：仅大小写不同的 POSIX 路径是两个
  // 真实目录，不得折叠合并（宁可在大小写不敏感卷上出现可手动移除的重复）。
  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "/Users/a/Skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));
  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "/users/a/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  const list = screen.getByRole("list", { name: "已选来源" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  expect(within(list).getByText("/Users/a/Skills")).toBeVisible();
  expect(within(list).getByText("/users/a/skills")).toBeVisible();
});

it("removes selected sources individually and all at once from the list", async () => {
  // DEV-9：批量删除标记复选框已移除（与行选中复选框并列造成语义混淆），
  // 删除收口为「单条移除 + 全部清空」。
  const user = userEvent.setup();
  await renderGuidedWizard();

  await user.clear(screen.getByLabelText("来源"));
  await user.type(screen.getByLabelText("来源"), "C:/windsurf/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));

  // 逐条删除。
  await user.click(screen.getByRole("button", { name: "移除已选来源 C:/codex/skills" }));
  const list = screen.getByRole("list", { name: "已选来源" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);

  await user.click(screen.getByRole("button", { name: "移除已选来源 C:/claude/skills" }));
  await user.click(screen.getByRole("button", { name: "移除已选来源 C:/windsurf/skills" }));
  expect(screen.getByRole("list", { name: "已选来源" })).toBeVisible();

  // 清空后重新添加一个来源，再全部清空。
  await user.type(screen.getByLabelText("来源"), "C:/solo/skills");
  await user.click(screen.getByRole("button", { name: "添加到已选来源" }));
  expect(screen.getByRole("list", { name: "已选来源" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "全部清空" }));
  expect(screen.getByRole("list", { name: "已选来源" })).toBeVisible();
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
  expect(within(list).getByText("C:\\codex\\skills")).toBeVisible();
  expect(within(list).getByText("C:\\extra\\skills")).toBeVisible();
  expect(facade.calls.acquiredSources).toContain("C:/extra/skills");
});

it("restores scan results and candidate selection after the wizard remounts", async () => {
  // DEV-12：候选选到一半切走再回来——扫描结果（逐来源候选数）与已勾选
  // 候选原样恢复；恢复不触发重新扫描。
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const first = render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
        <ImportWizard facade={facade} initialSources={["C:/codex/skills", "C:/claude/skills"]} initialSourceText="C:/codex/skills" />
      </I18nextProvider>
    </TestShell>,
  );
  await user.click(await screen.findByRole("button", { name: "读取已选目录候选" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  const pdfCheckbox = screen.getAllByRole("checkbox", { name: /PDF/ })[0];
  await user.click(pdfCheckbox);
  expect(pdfCheckbox).toBeChecked();
  const callsBeforeRemount = facade.calls.acquiredSources.length;
  first.unmount();

  render(
    <TestShell>
      <I18nextProvider i18n={i18n}>
        <ImportWizard facade={facade} initialSources={["C:/codex/skills", "C:/claude/skills"]} initialSourceText="C:/codex/skills" />
      </I18nextProvider>
    </TestShell>,
  );

  // 恢复停在扫描结果门槛步；继续后勾选原样，且全程未重新扫描。
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  const restoredCheckboxes = await screen.findAllByRole("checkbox", { name: /PDF/ });
  expect(restoredCheckboxes[0]).toBeChecked();
  expect(facade.calls.acquiredSources).toHaveLength(callsBeforeRemount);
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
  expect(within(items[0]).getByText("C:\\codex\\skills")).toBeVisible();
});

it("automatically acquires onboarding sources without a second read action", async () => {
  const facade = await renderGuidedWizard(undefined, "onboarding");

  // 初始化导入不再提供“添加到已选来源”。
  expect(screen.queryByRole("button", { name: "添加到已选来源" })).not.toBeInTheDocument();

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

  // 手动选择的目录自动进入已选来源，并与初始化来源一起静默解析。
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual(expect.arrayContaining([
    "C:/picked/skills",
    "C:/codex/skills",
    "C:/claude/skills",
  ]));
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
  expect(await screen.findByText("候选项已准备好")).toBeVisible();
  const sourceList = screen.getByRole("list", { name: "已选来源" });
  expect(within(sourceList).getAllByText("2 个候选")).toHaveLength(2);
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

  // DEV-13：本机选取的目录解析一次；挂载时已选来源自动解析过，批量读取
  // 视预览缓存是否命中可能重扫，因此只断言它们都参与了获取。
  const acquired = facade.calls.acquiredSources;
  expect(acquired.filter((source) => source === "C:/picked/skills")).toHaveLength(1);
  expect(acquired).toContain("C:/codex/skills");
  expect(acquired).toContain("C:/claude/skills");
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

it("renders governance before conflicts and sends group plus member override to commit", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const originalAnalyze = facade.analyzeConflicts.bind(facade);
  const commitImport = vi.fn(async (
    plan: ImportPlan,
    actions: Record<string, ImportAction>,
    _onProgress?: (progress: ImportProgress) => void,
    governanceDecision?: ImportGovernanceDecision,
  ): Promise<ImportResult[]> => {
    expect(plan.governanceGroups).toHaveLength(1);
    expect(actions).toEqual({});
    expect(governanceDecision).toEqual({
      group_actions: { "unrecognized-source": "create_todo" },
      item_overrides: { "safe-pdf": "preserve_original" },
    });
    return [{
      action: "copy",
      candidateId: "safe-pdf",
      message: "importWorkflow.commitMessages.imported",
      originalPreserved: true,
      status: "todo",
    }];
  });
  facade.analyzeConflicts = vi.fn(async (candidates, onProgress) => {
    const plan = await originalAnalyze(candidates, onProgress);
    return {
      ...plan,
      governanceGroups: [{
        group_id: "unrecognized-source",
        classification: "unrecognized_source",
        default_action: "create_todo",
        available_actions: ["preserve_original", "create_todo"],
        members: [{
          member_id: "safe-pdf",
          display_name: "PDF",
          source_path: "C:/skills/safe-pdf",
          affected_agents: [],
        }],
      } satisfies ImportGovernanceGroup],
    };
  });
  facade.commitImport = commitImport;
  await renderWizard(facade);

  await user.type(screen.getByLabelText("来源"), "C:/skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  expect(await screen.findByRole("heading", { name: "确认导入后的关系处理" })).toBeVisible();
  await user.click(screen.getByRole("radio", { name: "创建待办" }));
  await user.click(screen.getByRole("button", { name: "展开 1 个项目" }));
  await user.click(screen.getByRole("radio", { name: "PDF：原件保留" }));
  await user.click(screen.getByRole("button", { name: "确认关系处理" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));

  expect(commitImport).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("待处理")).toBeVisible();
});

it("requires a new governance confirmation after returning to candidates and reanalyzing", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const originalAnalyze = facade.analyzeConflicts.bind(facade);
  facade.analyzeConflicts = vi.fn(async (candidates, onProgress) => ({
    ...(await originalAnalyze(candidates, onProgress)),
    governanceGroups: [{
      group_id: "same-group",
      classification: "unrecognized_source",
      default_action: "create_todo",
      available_actions: ["preserve_original", "create_todo"],
      members: [{
        member_id: "safe-pdf",
        display_name: "PDF",
        source_path: "C:/skills/safe-pdf",
        affected_agents: [],
      }],
    } satisfies ImportGovernanceGroup],
  }));
  await renderWizard(facade);

  await user.type(screen.getByLabelText("来源"), "C:/skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await screen.findByRole("heading", { name: "确认导入后的关系处理" });
  await user.click(screen.getByRole("radio", { name: "创建待办" }));

  await user.click(screen.getByRole("button", { name: "上一步" }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  await screen.findByRole("heading", { name: "确认导入后的关系处理" });
  expect(screen.getByRole("button", { name: "确认关系处理" })).toBeDisabled();
});

it("counts todo results as attention in the status, notification, and tracked summary", async () => {
  const user = userEvent.setup();
  const tracker = createOperationTracker();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.commitImport = vi.fn(async (): Promise<ImportResult[]> => [{
    action: "copy",
    candidateId: "safe-pdf",
    message: "importWorkflow.commitMessages.imported",
    originalPreserved: true,
    status: "todo",
  }]);
  await renderWithTracker(facade, tracker);

  await user.type(screen.getByLabelText("来源"), "C:/skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));

  const notice = await screen.findByTestId("notice-warning");
  // todo 结果属于"需要关注"而非失败：通知标题与状态区都不再借用失败文案。
  expect(within(notice).getByText("导入需要处理")).toBeVisible();
  expect(within(notice).getByText(/待处理 1/)).toBeVisible();
  expect(screen.getByText("导入完成，有待处理事项", { selector: ".sh-import-wizard__status" })).toBeVisible();
  expect(tracker.getSnapshot()[0].resultSummary).toEqual({
    succeeded: 0,
    failed: 0,
    skipped: 0,
    todo: 1,
  });
});

it("drives the unified tracker through queued, running and failed when the commit command throws", async () => {
  const user = userEvent.setup();
  const tracker = createOperationTracker();
  const transitions: Array<string | undefined> = [];
  let previous = "";
  tracker.subscribe(() => {
    const status = tracker.getSnapshot()[0]?.status;
    if (status !== previous) {
      transitions.push(status);
      previous = status ?? "";
    }
  });
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.commitImport = vi.fn(async (_plan, _actions, onProgress) => {
    onProgress?.({ candidateId: "safe-pdf", completed: 1, total: 1 });
    // 命令中途抛错：tracker 必须落 failed，异常原样上抛由向导告警承接。
    throw new Error("native commit exploded");
  });
  await renderWithTracker(facade, tracker);

  await user.type(screen.getByLabelText("来源"), "C:/skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));

  // 异常不吞掉：向导失败态可见（状态区展示失败文案，danger 通知照发）。
  expect(await screen.findByTestId("notice-danger")).toBeVisible();
  expect(screen.getByText("导入需要处理", { selector: ".sh-import-wizard__status" })).toBeVisible();
  expect(transitions).toEqual(["queued", "running", "failed"]);
  const [operation] = tracker.getSnapshot();
  expect(operation.status).toBe("failed");
  expect(operation.error).toBe("native commit exploded");
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
  // 统一生命周期（任务 4）：全部成功落 success，不再有笼统 completed。
  expect(operation.status).toBe("success");
  expect(operation.completed).toBe(operation.total);
  expect(operation.resultSummary).toEqual({ succeeded: 1, failed: 0, skipped: 1, todo: 0 });
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
  // begin 即在途（queued）：互斥同样阻塞尚未 start 的后续导入。
  expect(["queued", "running"]).toContain(tracker.getSnapshot()[0].status);
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
  expect(screen.getByText("可以离开此页面；导入会在后台继续。请通过顶栏任务状态查看进度，完成后到通知中心查看结果。")).toBeVisible();
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

describe("conflict analysis progress", () => {
  function deferredPlan() {
    let resolve!: (plan: ImportPlan) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<ImportPlan>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, reject, resolve };
  }

  async function reachCandidateSelection(
    user: ReturnType<typeof userEvent.setup>,
    facade: ReturnType<typeof createMockImportFacade>,
  ) {
    await renderWizard(facade);
    await user.type(screen.getByLabelText("来源"), "C:/incoming");
    await user.click(screen.getByRole("button", { name: "解析来源" }));
    await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
    await user.click(screen.getByRole("button", { name: "全选可导入候选" }));
  }

  it("shows the real phase, total and elapsed time as soon as analysis starts", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const gate = deferredPlan();
    facade.analyzeConflicts = vi.fn(() => gate.promise);
    await reachCandidateSelection(user, facade);

    await user.click(screen.getByRole("button", { name: "分析冲突" }));

    // 分析开始即有真实反馈：阶段名（状态区同时播报）、送入分析的总数与已用时间。
    const progress = await screen.findByRole("region", { name: "冲突分析进度" });
    expect(within(progress).getByText("正在分析冲突")).toBeVisible();
    expect(within(progress).getByText("正在分析 2 个候选")).toBeVisible();
    expect(within(progress).getByText("已用时 0 秒")).toBeVisible();
    // 持久状态区与进度区同时播报真实阶段名称。
    expect(screen.getAllByText("正在分析冲突").length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      gate.resolve({ candidates: facade.fixtures.candidates, conflicts: [] });
    });
  });

  it("advances the real completed count and percentage as each candidate completes", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const gate = deferredPlan();
    facade.analyzeConflicts = vi.fn((_candidates, onProgress) => {
      onProgress?.({ candidateId: "safe-pdf", completed: 1, total: 2 });
      return gate.promise;
    });
    await reachCandidateSelection(user, facade);
    await user.click(screen.getByRole("button", { name: "分析冲突" }));

    const progress = await screen.findByRole("region", { name: "冲突分析进度" });
    expect(within(progress).getByText("已完成 1/2（50%）")).toBeVisible();
    const bar = within(progress).getByRole("progressbar");
    expect(bar).toHaveAttribute("value", "1");
    expect(bar).toHaveAttribute("max", "2");
    // 长时间分析：未结束时进度持续可见，不消失也不报错。
    expect(progress).toBeVisible();

    await act(async () => {
      gate.resolve({ candidates: facade.fixtures.candidates, conflicts: [] });
    });
    expect(await screen.findByRole("button", { name: "提交导入" })).toBeVisible();
  });

  it("shows an indeterminate progress without a fabricated percentage when no per-candidate progress is reported", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const gate = deferredPlan();
    // facade 不支持进度回调（旧契约）：只允许不确定进度，绝不伪造百分比。
    facade.analyzeConflicts = vi.fn(() => gate.promise);
    await reachCandidateSelection(user, facade);
    await user.click(screen.getByRole("button", { name: "分析冲突" }));

    const progress = await screen.findByRole("region", { name: "冲突分析进度" });
    const bar = within(progress).getByRole("progressbar");
    expect(bar).not.toHaveAttribute("value");
    expect(within(progress).queryByText(/%/)).not.toBeInTheDocument();
    expect(
      within(progress).getByText("当前环境未提供逐项分析进度；完成前不显示百分比。"),
    ).toBeVisible();

    await act(async () => {
      gate.resolve({ candidates: facade.fixtures.candidates, conflicts: [] });
    });
  });

  it("surfaces an analysis failure and offers a retry back to the candidates phase", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.analyzeConflicts = vi.fn(async () => {
      throw new Error("simulated analysis failure");
    });
    await reachCandidateSelection(user, facade);
    await user.click(screen.getByRole("button", { name: "分析冲突" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/simulated analysis failure/);
    await user.click(screen.getByRole("button", { name: "重试" }));

    // previousPhase 回退：失败重试直接回到候选阶段，已选候选保留，可再次分析。
    const analyze = await screen.findByRole("button", { name: "分析冲突" });
    expect(analyze).toBeEnabled();
    expect(facade.analyzeConflicts).toHaveBeenCalledTimes(1);
  });

  it("returns to candidates and drops the in-flight analysis when the user cancels", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const gate = deferredPlan();
    facade.analyzeConflicts = vi.fn(() => gate.promise);
    facade.cancel = vi.fn(() => Promise.resolve());
    await reachCandidateSelection(user, facade);
    await user.click(screen.getByRole("button", { name: "分析冲突" }));
    expect(await screen.findByRole("region", { name: "冲突分析进度" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "取消分析" }));

    // 取消后回到候选阶段，进度区消失；迟到的分析结果被丢弃，不进入冲突阶段。
    expect(await screen.findByRole("button", { name: "分析冲突" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "冲突分析进度" })).not.toBeInTheDocument();
    expect(facade.cancel).toHaveBeenCalled();
    expect(document.querySelector('[data-testid="notice-info"]')).not.toBeNull();
    await act(async () => {
      gate.resolve({ candidates: facade.fixtures.candidates, conflicts: [] });
    });
    expect(screen.queryByRole("button", { name: "提交导入" })).not.toBeInTheDocument();
  });

  it("does not start a concurrent analysis when the analyze action repeats", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const gate = deferredPlan();
    facade.analyzeConflicts = vi.fn(() => gate.promise);
    await reachCandidateSelection(user, facade);

    await user.click(screen.getByRole("button", { name: "分析冲突" }));

    // 分析进行中不再渲染分析入口：重复点击无从发起并发分析。
    expect(screen.queryByRole("button", { name: "分析冲突" })).not.toBeInTheDocument();
    expect(facade.analyzeConflicts).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ candidates: facade.fixtures.candidates, conflicts: [] });
    });
    expect(await screen.findByRole("button", { name: "提交导入" })).toBeVisible();
    expect(facade.analyzeConflicts).toHaveBeenCalledTimes(1);
  });

  it("restarts progress from the new candidate total after a rollback to candidates", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    facade.analyzeConflicts = vi.fn(async () => {
      throw new Error("boom");
    });
    await reachCandidateSelection(user, facade);
    await user.click(screen.getByRole("button", { name: "分析冲突" }));
    await user.click(await screen.findByRole("button", { name: "重试" }));

    // 候选变化后重新返回：缩小选择集再分析，进度总数必须是新的真实总数。
    await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
    const gate = deferredPlan();
    facade.analyzeConflicts = vi.fn(() => gate.promise);
    await user.click(screen.getByRole("button", { name: "分析冲突" }));

    const progress = await screen.findByRole("region", { name: "冲突分析进度" });
    expect(within(progress).getByText("正在分析 1 个候选")).toBeVisible();

    await act(async () => {
      gate.resolve({ candidates: facade.fixtures.candidates, conflicts: [] });
    });
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
      await screen.findByText(/导入步骤未能完成（host\.weird_failure）。/),
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

  it("wires the governance AI notice to the real provider state", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const originalAnalyze = facade.analyzeConflicts.bind(facade);
    facade.runAiPreChecks = vi.fn();
    // Task 8 遗留修复：面板 aiAvailable 接真实供应商状态，而不是
    // Boolean(facade.runAiPreChecks)。未配置供应商 → 不可用提示必须可达。
    facade.listLlmProviders = vi.fn(async () => []);
    facade.analyzeConflicts = vi.fn(async (candidates, onProgress) => ({
      ...(await originalAnalyze(candidates, onProgress)),
      governanceGroups: [{
        group_id: "same-group",
        classification: "unrecognized_source",
        default_action: "create_todo",
        available_actions: ["preserve_original", "create_todo"],
        members: [{
          member_id: "safe-pdf",
          display_name: "PDF",
          source_path: "C:/skills/safe-pdf",
          affected_agents: [],
        }],
      } satisfies ImportGovernanceGroup],
    }));
    await renderWizard(facade);

    await user.type(screen.getByLabelText("来源"), "C:/skills");
    await user.click(screen.getByRole("button", { name: "解析来源" }));
    await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
    await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
    await user.click(screen.getByRole("button", { name: "分析冲突" }));
    expect(await screen.findByRole("heading", { name: "确认导入后的关系处理" })).toBeVisible();

    expect(
      screen.getByText("AI 建议未配置；已保留确定性关系判断。"),
    ).toBeVisible();
    expect(facade.listLlmProviders).toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "创建待办" }));
    await user.click(screen.getByRole("button", { name: "确认关系处理" }));
    expect(await screen.findByRole("button", { name: "提交导入" })).toBeVisible();
    // 预检入口同样诚实：无供应商时不出现运行按钮，并给出原因说明。
    expect(screen.queryByRole("button", { name: "运行 AI 预检" })).not.toBeInTheDocument();
    expect(
      screen.getByText("尚未配置可用的 LLM 供应商，无法运行 AI 预检；可直接继续导入。"),
    ).toBeVisible();
  });

  it("keeps the AI entries available when a usable provider is configured", async () => {
    const user = userEvent.setup();
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const originalAnalyze = facade.analyzeConflicts.bind(facade);
    facade.runAiPreChecks = vi.fn();
    facade.analyzeConflicts = vi.fn(async (candidates, onProgress) => ({
      ...(await originalAnalyze(candidates, onProgress)),
      governanceGroups: [{
        group_id: "same-group",
        classification: "unrecognized_source",
        default_action: "create_todo",
        available_actions: ["preserve_original", "create_todo"],
        members: [{
          member_id: "safe-pdf",
          display_name: "PDF",
          source_path: "C:/skills/safe-pdf",
          affected_agents: [],
        }],
      } satisfies ImportGovernanceGroup],
    }));
    await renderWizard(facade);

    await user.type(screen.getByLabelText("来源"), "C:/skills");
    await user.click(screen.getByRole("button", { name: "解析来源" }));
    await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
    await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
    await user.click(screen.getByRole("button", { name: "分析冲突" }));
    expect(await screen.findByRole("heading", { name: "确认导入后的关系处理" })).toBeVisible();

    // 默认 mock 供应商已配置并启用：治理区不再显示不可用提示。
    expect(
      screen.queryByText("AI 建议未配置；已保留确定性关系判断。"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "创建待办" }));
    await user.click(screen.getByRole("button", { name: "确认关系处理" }));
    expect(
      await screen.findByRole("button", { name: "运行 AI 预检" }),
    ).toBeVisible();
    expect(
      screen.queryByText("尚未配置可用的 LLM 供应商，无法运行 AI 预检；可直接继续导入。"),
    ).not.toBeInTheDocument();
  });
});
