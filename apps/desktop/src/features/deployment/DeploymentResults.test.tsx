import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { DeploymentResults } from "./DeploymentResults";

it("renders the committed-blocked outcome as its user-facing copy, not a raw key", async () => {
  // nativeApi 把 blocked pair 投影为 failed + committedBlocked 文案键；
  // 结果面必须解析键文案，而不是把键名当未知错误码回显（跨层回归发现）。
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentResults results={[{
        targetId: "codex-global",
        label: "Codex CLI",
        status: "failed",
        message: "deployment.blockReason.committedBlocked",
      }]} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("该目标未能执行，保持原状。")).toBeVisible();
  expect(screen.queryByText(/deployment\.blockReason/)).not.toBeInTheDocument();
});

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
  // 占用冲突文案必须带出路引导：提示可改用「转入技能库管理」。
  expect(screen.getByText(/转入技能库管理/)).toBeVisible();
  expect(screen.queryByText("deployment.target_exists")).not.toBeInTheDocument();
});

it("renders the resolved display name as the primary label and never renders the raw Skill id (DEV-18-A + DEV-99)", async () => {
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
  // DEV-99：内部 id 全面退出界面——技术详情折叠区也不展示。
  expect(screen.queryByText("8f1c0b2e-4a9d-4f77-9a1e-2b6d5c3e7a10")).not.toBeInTheDocument();
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

it("explains replacement, rename, and recovery-required results with user-facing facts", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentResults results={[
        {
          skillId: "derived-skill-id",
          displayName: "PDF 抽取器",
          targetId: "codex-global",
          label: "Codex CLI",
          status: "succeeded",
          message: "deployment.results.status.message.renamed",
          conflictOutcome: "renamed",
          runtimeName: "pdf-reader-v2",
        },
        {
          skillId: "skill-pdf",
          displayName: "PDF 抽取器",
          targetId: "claude-global",
          label: "Claude Code",
          status: "succeeded",
          message: "deployment.results.status.message.replaced",
          conflictOutcome: "replaced",
          replacedSkillDisplayName: "旧版 PDF 技能",
        },
        {
          skillId: "skill-agent-secret-id",
          displayName: "Browser Helper",
          targetId: "cursor-global",
          label: "Cursor",
          status: "failed",
          message: "deployment.results.status.message.recoveryRequired",
          recoveryRequired: true,
          operationId: "opaque-operation-id",
        },
      ]} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("PDF 抽取器（pdf-reader-v2） · Codex CLI")).toBeVisible();
  expect(screen.getByText(/已使用新名称「pdf-reader-v2」完成派发/)).toBeVisible();
  expect(screen.getByText(/已替换目标中的「旧版 PDF 技能」并完成派发/)).toBeVisible();
  expect(screen.getByText(/操作未完成，需要前往操作记录恢复/)).toBeVisible();
  expect(screen.queryByText(/opaque-operation-id|skill-agent-secret-id/)).not.toBeInTheDocument();
});
