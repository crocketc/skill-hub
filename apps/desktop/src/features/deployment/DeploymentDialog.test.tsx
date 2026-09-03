import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { deploymentTargetsFixture, type DeploymentFacade } from "./api";
import { DeploymentDialog } from "./DeploymentDialog";

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
  expect(preview).toHaveBeenLastCalledWith([targets[1]]);
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
