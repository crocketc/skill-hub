import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { deploymentTargetsFixture, type DeploymentFacade, type DeploymentResult } from "./api";
import { DeploymentDialog } from "./DeploymentDialog";

async function renderDialog(facade: DeploymentFacade, onCommitted?: (results: Awaited<ReturnType<DeploymentFacade["commit"]>>) => void) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentDialog facade={facade} onCommitted={onCommitted} skillId="skill-pdf" versionId="v1" />
    </I18nextProvider>,
  );
  return i18n;
}

it("supports one or many Agent targets and reports each result", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture();
  const preview = vi.fn<DeploymentFacade["preview"]>(async (selected) => ({
    skillId: "skill-pdf",
    versionId: "v1",
    targets: selected.map((target) => ({
      targetId: target.id,
      label: target.label,
      mode: "symbolic_link" as const,
      warnings: [],
    })),
    warnings: [],
  }));
  const onCommitted = vi.fn();
  const facade: DeploymentFacade = {
    listTargets: async () => targets,
    preview,
    commit: async () => targets.slice(0, 2).map((target, index) => ({
      targetId: target.id,
      label: target.label,
      status: index === 0 ? "succeeded" as const : "failed" as const,
      message: index === 0 ? "已部署" : "目标目录不可写",
    })),
  };

  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentDialog
        skillId="skill-pdf"
        versionId="v1"
        facade={facade}
        onCommitted={onCommitted}
      />
    </I18nextProvider>,
  );

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  expect(await screen.findAllByTestId("target-plan")).toHaveLength(2);
  expect(screen.getAllByText("Codex CLI")).toHaveLength(2);
  expect(screen.getAllByText("Claude Code")).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "提交部署" }));
  expect(await screen.findAllByTestId("deployment-result")).toHaveLength(2);
  expect(onCommitted).toHaveBeenCalledWith([
    expect.objectContaining({ targetId: "codex-cli", status: "succeeded" }),
    expect.objectContaining({ targetId: "claude-code", status: "failed" }),
  ]);

  await user.click(screen.getByRole("button", { name: "重试失败目标" }));
  expect(screen.getByLabelText("Codex CLI")).not.toBeChecked();
  expect(screen.getByLabelText("Claude Code")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "预览部署" }));
  expect(preview).toHaveBeenLastCalledWith([targets[1]], undefined);
});

it("shows an empty state after target discovery completes", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: DeploymentFacade = {
    listTargets: async () => [],
    preview: vi.fn(),
    commit: vi.fn(),
  };

  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentDialog skillId="skill-pdf" versionId="v1" facade={facade} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("未发现可部署的 Agent 目标")).toBeInTheDocument();
  expect(screen.queryByText("正在加载部署目标")).not.toBeInTheDocument();
});

it("lets the user override the target default with a managed copy or a link", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture();
  const preview = vi.fn<DeploymentFacade["preview"]>(async () => ({
    skillId: "skill-pdf",
    versionId: "v1",
    targets: [],
    warnings: [],
  }));
  const facade: DeploymentFacade = { listTargets: async () => targets, preview, commit: vi.fn() };

  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentDialog skillId="skill-pdf" versionId="v1" facade={facade} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.selectOptions(screen.getByLabelText("部署方式"), "managed_copy");
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  expect(preview).toHaveBeenCalledWith([targets[0]], "managed_copy");
});

function planFacade(previewFn: DeploymentFacade["preview"], commitFn?: DeploymentFacade["commit"]): DeploymentFacade {
  return { listTargets: async () => deploymentTargetsFixture(), preview: previewFn, commit: commitFn ?? vi.fn() };
}

it("exposes the unified deploy step rail and keeps every action in a stable footer", async () => {
  const user = userEvent.setup();
  const targets = deploymentTargetsFixture();
  const facade = planFacade(async (selected) => ({
    skillId: "skill-pdf",
    versionId: "v1",
    targets: selected.map((target) => ({
      targetId: target.id,
      label: target.label,
      mode: "symbolic_link" as const,
      warnings: [],
    })),
    warnings: [],
  }), async () => targets.slice(0, 1).map((target) => ({
    targetId: target.id,
    label: target.label,
    status: "succeeded" as const,
    message: "部署成功",
  })));
  await renderDialog(facade);

  const rail = screen.getByRole("list", { name: "部署步骤" });
  const steps = within(rail).getAllByRole("listitem");
  expect(steps).toHaveLength(4);
  expect(steps[0]).toHaveAttribute("aria-current", "step");
  expect(steps[0]).toHaveTextContent("选择目标");
  expect(steps[1]).toHaveTextContent("预览影响");
  expect(steps[2]).toHaveTextContent("提交");
  expect(steps[3]).toHaveTextContent("结果");

  await screen.findByLabelText("Codex CLI");
  // 选择阶段的状态区持续播报当前阶段（图标+文字由 shell 提供）。
  expect(screen.getByRole("status")).toHaveTextContent("请选择要部署的目标");

  const previewButton = screen.getByRole("button", { name: "预览部署" });
  const footerBefore = previewButton.closest("footer");
  expect(footerBefore).not.toBeNull();

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(previewButton);

  // 主操作换成"提交部署"，但必须仍挂在同一个 footer 操作区。
  const commit = await screen.findByRole("button", { name: "提交部署" });
  expect(commit.closest("footer")).toBe(footerBefore);
  const stepsAfterPreview = within(screen.getByRole("list", { name: "部署步骤" })).getAllByRole("listitem");
  expect(stepsAfterPreview[1]).toHaveAttribute("aria-current", "step");

  await user.click(commit);
  expect(await screen.findAllByTestId("deployment-result")).toHaveLength(1);
  const stepsAfterCommit = within(screen.getByRole("list", { name: "部署步骤" })).getAllByRole("listitem");
  expect(stepsAfterCommit[0]).toHaveTextContent("已完成");
  expect(stepsAfterCommit[1]).toHaveTextContent("已完成");
  expect(stepsAfterCommit[2]).toHaveTextContent("已完成");
  expect(stepsAfterCommit[3]).toHaveAttribute("aria-current", "step");
});

it("hides the footer during the pure committing progress and announces it via the status region", async () => {
  const user = userEvent.setup();
  let resolveCommit: (value: DeploymentResult[]) => void = () => undefined;
  const facade = planFacade(async (selected) => ({
    skillId: "skill-pdf",
    versionId: "v1",
    targets: selected.map((target) => ({
      targetId: target.id,
      label: target.label,
      mode: "symbolic_link" as const,
      warnings: [],
    })),
    warnings: [],
  }), () => new Promise((resolve) => { resolveCommit = resolve; }));
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));
  await user.click(await screen.findByRole("button", { name: "提交部署" }));

  // 纯进度阶段不渲染 footer，提交动作不可重复触发。
  expect(screen.queryByRole("button", { name: "提交部署" })).not.toBeInTheDocument();
  expect(await screen.findByText("正在提交部署，请稍候")).toBeVisible();

  resolveCommit([{ targetId: "codex-cli", label: "Codex CLI", status: "succeeded", message: "部署成功" }]);
  expect(await screen.findByTestId("deployment-result")).toBeInTheDocument();
});

it("keeps the preview failure alert visible and the selection recoverable", async () => {
  const user = userEvent.setup();
  let failPreview = true;
  const preview = vi.fn<DeploymentFacade["preview"]>(async () => {
    if (failPreview) throw new Error("deployment.target_not_writable");
    return { skillId: "skill-pdf", versionId: "v1", targets: [], warnings: [] };
  });
  await renderDialog(planFacade(preview));

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  // 失败态：告警与目标选择并存，用户可以直接调整选择后重试预览。
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByLabelText("Codex CLI")).toBeEnabled();
  expect(screen.getByLabelText("Claude Code")).toBeEnabled();

  failPreview = false;
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  expect(await screen.findByRole("button", { name: "提交部署" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(2);
});

it("reports partial failure with its own status and keeps the retry in the footer", async () => {
  const user = userEvent.setup();
  const facade = planFacade(async (selected) => ({
    skillId: "skill-pdf",
    versionId: "v1",
    targets: selected.map((target) => ({
      targetId: target.id,
      label: target.label,
      mode: "symbolic_link" as const,
      warnings: [],
    })),
    warnings: [],
  }), async () => [
    { targetId: "codex-cli", label: "Codex CLI", status: "succeeded", message: "部署成功" },
    { targetId: "claude-code", label: "Claude Code", status: "failed", message: "目标目录不可写" },
  ]);
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));
  await user.click(await screen.findByRole("button", { name: "提交部署" }));

  // 部分成功是独立的警告状态，不与完全成功混同。
  expect(await screen.findByText("部署已完成，部分目标失败")).toBeVisible();
  const retry = screen.getByRole("button", { name: "重试失败目标" });
  expect(retry.closest("footer")).not.toBeNull();
});

it("returns keyboard focus to the deploy flow heading across phase changes", async () => {
  const user = userEvent.setup();
  const facade = planFacade(async (selected) => ({
    skillId: "skill-pdf",
    versionId: "v1",
    targets: selected.map((target) => ({
      targetId: target.id,
      label: target.label,
      mode: "symbolic_link" as const,
      warnings: [],
    })),
    warnings: [],
  }));
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  // 阶段切换时原主操作卸载；焦点必须落回流程标题，不能丢失到 body。
  await screen.findByRole("button", { name: "提交部署" });
  expect(screen.getByRole("heading", { name: "先预览，再修改 Agent 目标" })).toHaveFocus();
});
