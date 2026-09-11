import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { DeploymentResults } from "./DeploymentResults";

it("renders a structured target failure as localized, actionable text", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentResults results={[{
        targetId: "codex-global",
        label: "Codex CLI",
        status: "failed",
        message: "deployment.target_exists",
        error: {
          code: "deployment.target_exists",
          severity: "error",
          params: { path: "C:/Agents/pdf" },
          actions: ["choose_another_name", "inspect_target"],
        },
      }]} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("目标目录已存在，请选择其他名称或检查目标后再试。")).toBeVisible();
  expect(screen.queryByText("deployment.target_exists")).not.toBeInTheDocument();
});

it("resolves the native success result key through the existing translation tree", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentResults results={[{
        targetId: "codex-global",
        label: "Codex CLI",
        status: "succeeded",
        message: "deployment.results.status.message.succeeded",
      }]} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("部署成功")).toBeVisible();
});
