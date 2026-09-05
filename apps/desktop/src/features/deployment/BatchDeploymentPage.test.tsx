import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createSkillHubI18n } from "../../i18n";
import { BatchDeploymentPage } from "./BatchDeploymentPage";
import { deploymentTargetsFixture, type BatchDeploymentFacade, type DeploymentTarget } from "./api";

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
  expect(await screen.findAllByTestId("deployment-result")).toHaveLength(2);
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
