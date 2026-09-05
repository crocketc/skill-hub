import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { BatchDeploymentPage } from "./BatchDeploymentPage";
import { deploymentTargetsFixture, type BatchDeploymentFacade } from "./api";

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

  render(<I18nextProvider i18n={i18n}><BatchDeploymentPage facade={facade} skillIds={["skill-pdf", "skill-docx"]} /></I18nextProvider>);

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
