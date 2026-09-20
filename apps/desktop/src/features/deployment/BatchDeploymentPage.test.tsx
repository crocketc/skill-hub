import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import { BatchDeploymentPage } from "./BatchDeploymentPage";
import { deploymentTargetsFixture, type BatchDeploymentFacade, type BatchDeploymentResult, type DeploymentTarget } from "./api";

async function renderBatchPage(facade: BatchDeploymentFacade, skillIds: string[], initialEntry = "/deploy") {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <BatchDeploymentPage facade={facade} skillIds={skillIds} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function batchFacade(overrides: Partial<BatchDeploymentFacade> = {}): BatchDeploymentFacade {
  const targets = deploymentTargetsFixture().slice(0, 2);
  return {
    listTargets: async () => targets,
    preview: vi.fn<BatchDeploymentFacade["preview"]>(async (skillIds, selected) => ({
      failures: [],
      plans: skillIds.map((skillId) => ({
        skillId,
        plan: { skillId, versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
      })),
    })),
    commit: vi.fn<BatchDeploymentFacade["commit"]>(async (plans) => plans.flatMap(({ skillId, plan }) => plan.targets.map((target) => ({
      skillId,
      targetId: target.targetId,
      label: target.label,
      status: "succeeded" as const,
      message: "已部署",
    })))),
    ...overrides,
  };
}

it("hides unavailable targets from the default selection list (DEV-11)", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture(),
    preview: async () => ({ failures: [], plans: [] }),
    commit: async () => [],
  };
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  // 可用目标可选；不可用目标不出现在默认列表（文案承诺"已发现且可写"）。
  expect(await screen.findByLabelText("Codex CLI")).toBeVisible();
  expect(screen.queryByLabelText("Read-only Agent")).not.toBeInTheDocument();
});

it("previews every selected Skill before explicitly committing a batch", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture().slice(0, 2);
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (skillIds, selected) => ({
    failures: [],
    plans: skillIds.map((skillId) => ({
      skillId,
      plan: {
        skillId,
        versionId: "v1",
        targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy", warnings: [] })),
        warnings: [],
      },
    })),
  }));
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async (plans) => plans.flatMap(({ skillId, plan }) => plan.targets.map((target) => ({
    skillId,
    targetId: target.targetId,
    label: target.label,
    status: "succeeded" as const,
    message: "已部署",
  }))));
  const facade: BatchDeploymentFacade = { listTargets: async () => targets, preview, commit };

  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf", "skill-docx"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findByText("skill-pdf")).toBeVisible();
  expect(screen.getByText("skill-docx")).toBeVisible();
  expect(preview).toHaveBeenCalledWith(["skill-pdf", "skill-docx"], [targets[0]], undefined);

  await user.click(screen.getByRole("button", { name: "确认添加" }));
  const summary = await screen.findByTestId("batch-summary");
  expect(summary).toHaveTextContent("成功 2");
  expect(commit).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ skillId: "skill-pdf" }),
    expect.objectContaining({ skillId: "skill-docx" }),
  ]), expect.anything());
});


it("expands a selected project into its linked agent targets", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const agent: DeploymentTarget = { id: "logical-agent-1", label: "Codex CLI", path: "C:/codex/skills", available: true, physicalId: "p1", modes: ["managed_copy"] };
  const project: DeploymentTarget = { id: "project-1", label: "我的项目", path: "D:/proj", available: true, physicalId: "p2", modes: ["managed_copy"] };
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (skillIds, selected) => ({
    failures: [],
    plans: skillIds.map((skillId) => ({
      skillId,
      plan: { skillId, versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
    })),
  }));
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async () => []);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => [agent, project],
    preview,
    commit,
    listProjects: async () => [{ id: "project-1", agentIds: ["logical-agent-1"] }],
  };

  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("我的项目"));
  expect(screen.getByRole("button", { name: /展开关联 Agent/ })).toBeVisible();

  await user.click(screen.getByRole("button", { name: /展开关联 Agent/ }));
  expect(screen.getByLabelText("Codex CLI")).toBeChecked();

  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(screen.getByRole("button", { name: "确认添加" }));
  await waitFor(() => expect(preview).toHaveBeenLastCalledWith(
    ["skill-pdf"],
    expect.arrayContaining([project, agent]),
    undefined,
  ));
});

it("states that batch commits are not atomic", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture().slice(0, 1),
    preview: async () => ({ failures: [], plans: [] }),
    commit: async () => [],
  };
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  expect(await screen.findByText(/不是原子操作/)).toBeVisible();
});


it("aggregates mixed batch outcomes into executable, skipped, conflict and failed groups", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture().slice(0, 2);
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (skillIds, selected) => ({
    failures: [],
    plans: skillIds.map((skillId) => ({
      skillId,
      plan: { skillId, versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
    })),
  }));
  const statuses = ["succeeded", "skipped", "failed"] as const;
  let index = 0;
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async (plans) => plans.flatMap(({ skillId, plan }) => plan.targets.map((target) => ({
    skillId,
    targetId: target.targetId,
    label: target.label,
    status: statuses[index++ % statuses.length],
    message: "结果说明",
  }))));
  const facade: BatchDeploymentFacade = { listTargets: async () => targets, preview, commit };

  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-a", "skill-b", "skill-c"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));

  const summary = await screen.findByTestId("batch-summary");
  expect(summary).toHaveTextContent("成功 1");
  expect(summary).toHaveTextContent("跳过 1");
  expect(summary).toHaveTextContent("失败 1");
  expect(screen.getAllByTestId("batch-outcome-failed")).toHaveLength(1);
});

it("renders structured native target failures as actionable batch text", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture().slice(0, 1);
  const facade = batchFacade({
    commit: vi.fn<BatchDeploymentFacade["commit"]>(async () => [{
      skillId: "skill-pdf",
      targetId: "codex-cli",
      label: "Codex CLI",
      status: "failed",
      message: "deployment.target_exists",
      error: {
        code: "deployment.target_exists",
        severity: "error",
        params: { path: "C:/Agents/pdf" },
        actions: ["choose_another_name", "inspect_target"],
      },
    }]),
  });

  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));

  expect(await screen.findByText(/目标目录已存在同名内容，无法重复添加/)).toBeVisible();
  expect(screen.queryByText("deployment.target_exists")).not.toBeInTheDocument();
  expect(targets).toHaveLength(1);
});

it("preselects the target passed via the target search parameter", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture().slice(0, 2);
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (skillIds, selected) => ({
    failures: [],
    plans: skillIds.map((skillId) => ({
      skillId,
      plan: { skillId, versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
    })),
  }));
  const facade: BatchDeploymentFacade = { listTargets: async () => targets, preview, commit: async () => [] };

  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[{ pathname: "/deploy", search: "?skill=skill-pdf&target=claude-code" }]}>
        <BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  await waitFor(() => expect(screen.getByLabelText("Claude Code")).toBeChecked());
  expect(screen.getByLabelText("Codex CLI")).not.toBeChecked();

  await user.click(screen.getByRole("button", { name: "预览" }));
  await waitFor(() => expect(preview).toHaveBeenCalledWith(["skill-pdf"], [targets[1]], undefined));
});

it("exposes the batch step rail and keeps the non-atomic risk adjacent to the commit", async () => {
  const user = userEvent.setup();
  const facade = batchFacade();
  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);

  const rail = screen.getByRole("list", { name: "添加步骤" });
  const steps = within(rail).getAllByRole("listitem");
  expect(steps).toHaveLength(4);
  expect(steps[0]).toHaveAttribute("aria-current", "step");
  expect(steps[3]).toHaveTextContent("结果");

  await screen.findByLabelText("Codex CLI");
  // 非原子风险在选择阶段就可见，并且随流程进入 footer 操作区。
  const risk = screen.getByText(/不是原子操作/);
  expect(risk.closest("footer")).not.toBeNull();

  const previewButton = screen.getByRole("button", { name: "预览" });
  const footerBefore = previewButton.closest("footer");
  expect(footerBefore).not.toBeNull();

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(previewButton);

  const commit = await screen.findByRole("button", { name: "确认添加" });
  expect(commit.closest("footer")).toBe(footerBefore);
  // 提交动作与非原子风险提示必须相邻（同一个 footer 操作区内）。
  expect(within(commit.closest("footer") as HTMLElement).getByText(/不是原子操作/)).toBeVisible();
  expect(within(screen.getByRole("list", { name: "添加步骤" })).getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "step");

  await user.click(commit);
  expect(await screen.findByTestId("batch-summary")).toHaveTextContent("成功 2");
  expect(facade.commit).toHaveBeenCalledTimes(1);
});

it("returns keyboard focus to the batch flow heading across phase changes", async () => {
  const user = userEvent.setup();
  await renderBatchPage(batchFacade(), ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  await screen.findByRole("button", { name: "确认添加" });
  expect(screen.getByRole("heading", { name: "添加 2 个 Skill" })).toHaveFocus();
});

it("blocks the batch commit and announces the failure when a skill preview fails", async () => {
  const user = userEvent.setup();
  const facade = batchFacade({
    preview: vi.fn<BatchDeploymentFacade["preview"]>(async (_skillIds, selected) => ({
      failures: [{ skillId: "skill-docx", message: "版本缺失" }],
      plans: [{
        skillId: "skill-pdf",
        plan: { skillId: "skill-pdf", versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
      }],
    })),
  });
  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 失败列表保持独立告警；提交被阻止并有明确的失败播报。
  expect(await screen.findByRole("alert")).toHaveTextContent("skill-docx");
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
  expect(screen.getByText("部分 Skill 无法生成预览，已阻止提交")).toBeVisible();
  expect(facade.commit).not.toHaveBeenCalled();
});

it("maps the skill UUID to a display name in preview failure rows and keeps the raw id in technical details (DEV-18-A)", async () => {
  const user = userEvent.setup();
  const facade = batchFacade({
    preview: vi.fn<BatchDeploymentFacade["preview"]>(async (_skillIds, selected) => ({
      failures: [{
        skillId: "skill-docx",
        displayName: "PDF 抽取器",
        message: "版本缺失",
      }],
      plans: [{
        skillId: "skill-pdf",
        plan: { skillId: "skill-pdf", versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
      }],
    })),
  });
  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 主文案显示展示名，绝不在首屏呈现裸 UUID。
  const alert = await screen.findByRole("alert");
  expect(screen.getByText("PDF 抽取器")).toBeVisible();
  // 裸 UUID 仅出现在「技术详情」可展开区域内，不得作为首屏主文案。
  const idNode = screen.getByText("skill-docx");
  expect(idNode.closest("details")).not.toBeNull();
  // 主文案的展示名与裸 UUID 不是同一个节点。
  expect(alert.querySelector("strong")).toHaveTextContent("PDF 抽取器");
});

it("labels each batch plan with the resolved display name instead of the raw Skill id (DEV-18-A)", async () => {
  const user = userEvent.setup();
  const facade = batchFacade({
    preview: vi.fn<BatchDeploymentFacade["preview"]>(async (_skillIds, selected) => ({
      failures: [],
      plans: [{
        skillId: "sku-0001-aaaa",
        displayName: "PDF 抽取器",
        plan: { skillId: "sku-0001-aaaa", versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
      }],
    })),
  });
  await renderBatchPage(facade, ["sku-0001-aaaa"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  expect(within(plan).getByRole("heading", { name: "PDF 抽取器" })).toBeVisible();
  // 裸 UUID 不作为计划区主文案出现。
  expect(within(plan).queryByText("sku-0001-aaaa")).toBeNull();
});

it("renders a preview occupancy conflict as readable text with takeover guidance", async () => {
  const user = userEvent.setup();
  const facade = batchFacade({
    preview: vi.fn<BatchDeploymentFacade["preview"]>(async (_skillIds, selected) => ({
      failures: [{
        skillId: "skill-docx",
        message: "[object Object]",
        error: {
          code: "deployment.target_exists",
          severity: "error",
          params: { path: "C:/Users/demo/.claude/skills/find-skills" },
          actions: ["choose_another_name", "inspect_target"],
        },
      }],
      plans: [{
        skillId: "skill-pdf",
        plan: { skillId: "skill-pdf", versionId: "v1", targets: selected.map((target) => ({ targetId: target.id, label: target.label, mode: "managed_copy" as const, warnings: [] })), warnings: [] },
      }],
    })),
  });
  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("[object Object]");
  expect(alert.textContent).toContain("目标目录已存在");
  // 占用冲突必须引导出路：提示可改用「纳入集中库管理」。
  expect(alert.textContent).toContain("纳入集中库管理");
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
});

it("swaps the target list for the plan panel at the preview step and supports going back", async () => {
  // DEV-17：计划区必须是独立呈现单元——预览步不再把「添加计划」追加在
  // 目标长列表尾部；提供「上一步」返回选择，勾选状态保持。
  const user = userEvent.setup();
  await renderBatchPage(batchFacade(), ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 预览步：目标选择列表退出首屏，仅呈现计划区。
  expect(screen.queryByRole("region", { name: "Agent 目标" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: /添加计划/ })).toBeVisible();
  expect(screen.queryByRole("checkbox", { name: "Codex CLI" })).not.toBeInTheDocument();

  // 上一步：回到选择步，勾选保持。
  await user.click(screen.getByRole("button", { name: "上一步" }));
  const codex = await screen.findByRole("checkbox", { name: "Codex CLI" });
  expect(codex).toBeChecked();
});

it("hides the batch footer during committing and announces the non-atomic progress", async () => {
  const user = userEvent.setup();
  let resolveCommit: (value: Awaited<ReturnType<BatchDeploymentFacade["commit"]>>) => void = () => undefined;
  const facade = batchFacade({
    commit: vi.fn(() => new Promise<BatchDeploymentResult[]>((resolve) => { resolveCommit = resolve; })),
  });
  await renderBatchPage(facade, ["skill-pdf"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));

  expect(screen.queryByRole("button", { name: "确认添加" })).not.toBeInTheDocument();
  expect(await screen.findByText(/正在添加，请稍候；批次非原子/)).toBeVisible();

  resolveCommit([{ skillId: "skill-pdf", targetId: "codex-cli", label: "Codex CLI", status: "succeeded" as const, message: "已部署" }]);
  expect(await screen.findByTestId("batch-summary")).toHaveTextContent("成功 1");
});

describe("BatchDeploymentPage 与统一执行桥", () => {
  it("reports the batch commit to the unified tracker with per-skill progress and a partial finish", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    let resolveCommit!: (value: BatchDeploymentResult[]) => void;
    const facade = batchFacade({
      commit: vi.fn<BatchDeploymentFacade["commit"]>((plans, onProgress) => new Promise((resolve) => {
        resolveCommit = (value) => {
          onProgress?.(plans.length);
          resolve(value);
        };
      })),
    });
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/deploy"]}>
          <BatchDeploymentPage facade={facade} skillIds={["skill-pdf", "skill-docx"]} tracker={tracker} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));

    // 批次在途：一个批次任务（不是每个 Skill 一条），进度按已完成 Skill 推进。
    const [inFlight] = tracker.getSnapshot();
    expect(inFlight.status).toBe("running");
    expect(inFlight.kind).toBe("deploy");
    expect(inFlight.label).toBe("添加到 Agent/项目");
    expect(inFlight.total).toBe(2);
    expect(inFlight.completed).toBe(0);

    // 后端事实：批次逐 Skill prepare/commit，每个 Skill 的持久化 operation id
    // 互不相同（DeploymentService.prepare 每次 OperationId::new()）。
    resolveCommit([
      { skillId: "skill-pdf", targetId: "codex-cli", label: "Codex CLI", status: "succeeded", message: "deployment.results.status.message.succeeded", operationId: "op-batch-1" },
      { skillId: "skill-docx", targetId: "codex-cli", label: "Codex CLI", status: "failed", message: "目标目录不可写", operationId: "op-batch-2" },
    ]);
    expect(await screen.findByTestId("batch-summary")).toBeVisible();

    const [finished] = tracker.getSnapshot();
    expect(finished.status).toBe("partial");
    expect(finished.completed).toBe(2);
    // 多 id 批次不得伪关联到 Skill #1 的单条记录（镜像 removal 批量的既有
    // 决定）：无单 id correlate，深链退化为不带 action 的批量结果反馈。
    expect(finished.operationId).toBeNull();
    expect(finished.targetHref).toBeNull();
  });

  it("keeps the single-id correlation when a one-Skill batch yields exactly one operation record", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const facade = batchFacade({
      commit: vi.fn<BatchDeploymentFacade["commit"]>(async () => [
        { skillId: "skill-pdf", targetId: "codex-cli", label: "Codex CLI", status: "succeeded", message: "deployment.results.status.message.succeeded", operationId: "op-single-1" },
      ]),
    });
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/deploy"]}>
          <BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} tracker={tracker} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));
    expect(await screen.findByTestId("batch-summary")).toBeVisible();

    // 单 Skill 批次只有一个持久化记录：现有 correlate 行为保持。
    const [finished] = tracker.getSnapshot();
    expect(finished.operationId).toBe("op-single-1");
    expect(finished.targetHref).toBe("/operations/op-single-1");
  });

  it("records a rejected batch on the tracker as failed and keeps the page alert", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const facade = batchFacade({
      commit: vi.fn<BatchDeploymentFacade["commit"]>(async () => {
        throw new Error("deployment.plan_stale");
      }),
    });
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/deploy"]}>
          <BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} tracker={tracker} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    const [failed] = tracker.getSnapshot();
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("deployment.plan_stale");
  });
});
