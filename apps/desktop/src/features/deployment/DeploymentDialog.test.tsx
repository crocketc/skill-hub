import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { deploymentTargetsFixture, type DeploymentFacade } from "./api";
import { DeploymentDialog } from "./DeploymentDialog";

it("supports one or many Agent targets and reports each result", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture();
  const facade: DeploymentFacade = {
    listTargets: async () => targets,
    preview: async (selected) => ({
      skillId: "skill-pdf",
      versionId: "v1",
      targets: selected.map((target) => ({
        targetId: target.id,
        label: target.label,
        mode: "symbolic_link" as const,
        warnings: [],
      })),
      warnings: [],
    }),
    commit: async () => targets.slice(0, 2).map((target, index) => ({
      targetId: target.id,
      label: target.label,
      status: index === 0 ? "succeeded" as const : "failed" as const,
      message: index === 0 ? "已部署" : "目标目录不可写",
    })),
  };

  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentDialog skillId="skill-pdf" versionId="v1" facade={facade} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览部署" }));

  expect(await screen.findAllByTestId("target-plan")).toHaveLength(2);
  expect(screen.getAllByText("Codex CLI")).toHaveLength(2);
  expect(screen.getAllByText("Claude Code")).toHaveLength(2);
});
