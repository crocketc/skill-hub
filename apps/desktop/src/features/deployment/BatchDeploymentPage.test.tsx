import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createSkillHubI18n } from "../../i18n";
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
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  expect(await screen.findByText("skill-pdf")).toBeVisible();
  expect(screen.getByText("skill-docx")).toBeVisible();
  expect(preview).toHaveBeenCalledWith(["skill-pdf", "skill-docx"], [targets[0]], undefined);

  await user.click(screen.getByRole("button", { name: "提交部署" }));
  const summary = await screen.findByTestId("batch-summary");
  expect(summary).toHaveTextContent("成功 2");
  expect(commit).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ skillId: "skill-pdf" }),
    expect.objectContaining({ skillId: "skill-docx" }),
  ]));
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

  await user.click(screen.getByRole("button", { name: "预览部署" }));
  await user.click(screen.getByRole("button", { name: "提交部署" }));
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
  await user.click(screen.getByRole("button", { name: "预览部署" }));
  await user.click(await screen.findByRole("button", { name: "提交部署" }));

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
  await user.click(screen.getByRole("button", { name: "预览部署" }));
  await user.click(await screen.findByRole("button", { name: "提交部署" }));

  expect(await screen.findByText("目标目录已存在，请选择其他名称或检查目标后再试。")).toBeVisible();
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

  await user.click(screen.getByRole("button", { name: "预览部署" }));
  await waitFor(() => expect(preview).toHaveBeenCalledWith(["skill-pdf"], [targets[1]], undefined));
});

it("exposes the batch step rail and keeps the non-atomic risk adjacent to the commit", async () => {
  const user = userEvent.setup();
  const facade = batchFacade();
  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);

  const rail = screen.getByRole("list", { name: "部署步骤" });
  const steps = within(rail).getAllByRole("listitem");
  expect(steps).toHaveLength(4);
  expect(steps[0]).toHaveAttribute("aria-current", "step");
  expect(steps[3]).toHaveTextContent("结果");

  await screen.findByLabelText("Codex CLI");
  // 非原子风险在选择阶段就可见，并且随流程进入 footer 操作区。
  const risk = screen.getByText(/不是原子操作/);
  expect(risk.closest("footer")).not.toBeNull();

  const previewButton = screen.getByRole("button", { name: "预览部署" });
  const footerBefore = previewButton.closest("footer");
  expect(footerBefore).not.toBeNull();

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(previewButton);

  const commit = await screen.findByRole("button", { name: "提交部署" });
  expect(commit.closest("footer")).toBe(footerBefore);
  // 提交动作与非原子风险提示必须相邻（同一个 footer 操作区内）。
  expect(within(commit.closest("footer") as HTMLElement).getByText(/不是原子操作/)).toBeVisible();
  expect(within(screen.getByRole("list", { name: "部署步骤" })).getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "step");

  await user.click(commit);
  expect(await screen.findByTestId("batch-summary")).toHaveTextContent("成功 2");
  expect(facade.commit).toHaveBeenCalledTimes(1);
});

it("returns keyboard focus to the batch flow heading across phase changes", async () => {
  const user = userEvent.setup();
  await renderBatchPage(batchFacade(), ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  await screen.findByRole("button", { name: "提交部署" });
  expect(screen.getByRole("heading", { name: "部署 2 个 Skill" })).toHaveFocus();
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
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  // 失败列表保持独立告警；提交被阻止并有明确的失败播报。
  expect(await screen.findByRole("alert")).toHaveTextContent("skill-docx");
  expect(screen.getByRole("button", { name: "提交部署" })).toBeDisabled();
  expect(screen.getByText("部分 Skill 无法生成部署预览，已阻止提交")).toBeVisible();
  expect(facade.commit).not.toHaveBeenCalled();
});

it("hides the batch footer during committing and announces the non-atomic progress", async () => {
  const user = userEvent.setup();
  let resolveCommit: (value: Awaited<ReturnType<BatchDeploymentFacade["commit"]>>) => void = () => undefined;
  const facade = batchFacade({
    commit: vi.fn(() => new Promise<BatchDeploymentResult[]>((resolve) => { resolveCommit = resolve; })),
  });
  await renderBatchPage(facade, ["skill-pdf"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));
  await user.click(await screen.findByRole("button", { name: "提交部署" }));

  expect(screen.queryByRole("button", { name: "提交部署" })).not.toBeInTheDocument();
  expect(await screen.findByText(/正在部署，请稍候；批次非原子/)).toBeVisible();

  resolveCommit([{ skillId: "skill-pdf", targetId: "codex-cli", label: "Codex CLI", status: "succeeded" as const, message: "已部署" }]);
  expect(await screen.findByTestId("batch-summary")).toHaveTextContent("成功 1");
});
