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

  expect(await screen.findByText(/目标目录已存在同名内容，无法重复添加/)).toBeVisible();
  // 占用冲突文案必须带出路引导（DEV-18）：提示可改用「纳入集中库管理」。
  expect(screen.getByText(/纳入集中库管理/)).toBeVisible();
  expect(screen.queryByText("deployment.target_exists")).not.toBeInTheDocument();
});

it("renders the resolved display name as the primary label and keeps the raw Skill id in technical details (DEV-18-A)", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentResults results={[{
        skillId: "8f1c0b2e-4a9d-4f77-9a1e-2b6d5c3e7a10",
        displayName: "PDF 抽取器",
        targetId: "codex-global",
        label: "Codex CLI",
        status: "succeeded",
        message: "deployment.results.status.message.succeeded",
      }]} />
    </I18nextProvider>,
  );

  // 主文案是展示名，不是内部 Skill UUID。
  expect(await screen.findByText("PDF 抽取器 · Codex CLI")).toBeVisible();
  // 裸 UUID 只出现在可展开的技术详情区域内。
  expect(screen.getByText("8f1c0b2e-4a9d-4f77-9a1e-2b6d5c3e7a10").closest("details")).not.toBeNull();
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

  expect(await screen.findByText("添加成功")).toBeVisible();
});
