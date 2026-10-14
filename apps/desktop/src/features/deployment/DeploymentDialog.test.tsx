import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import {
  customAgentDeploymentTargetFixture,
  deploymentTargetsFixture,
  type BatchDeploymentFacade,
  type BatchDeploymentResult,
  type DeploymentPairPreview,
  type DeploymentPreviewBatch,
  type DeploymentResult,
  type DeploymentTarget,
} from "./api";
import type { AgentCardModel } from "../agents/agentCardModel";
import { DeploymentDialog } from "./DeploymentDialog";

let pairSeq = 0;

function pair(overrides: Partial<DeploymentPairPreview> = {}): DeploymentPairPreview {
  pairSeq += 1;
  return {
    pairId: `skill-pdf:fs-${pairSeq}`,
    skillId: "skill-pdf",
    skillDisplayName: "PDF 抽取器",
    logicalTargetIds: ["codex-cli"],
    runtimeName: "pdf",
    targetLabel: "Codex CLI",
    targetPath: "C:/Users/demo/.codex/skills",
    destinationPath: "C:/Users/demo/.codex/skills/pdf",
    preference: "automatic",
    disposition: "selected_mode",
    mode: "managed_copy",
    fallbackMode: null,
    blockReason: null,
    warnings: [],
    confirmationPreserved: false,
    confirmationFingerprint: `fp-${pairSeq}`,
    technicalError: null,
    ...overrides,
  };
}

function previewBatch(pairs: DeploymentPairPreview[], preservedConfirmationIds: string[] = []): DeploymentPreviewBatch {
  return {
    previewId: `preview-${pairSeq}`,
    expiresAt: "2026-09-24T01:00:00Z",
    pairs,
    preservedConfirmationIds,
  };
}

function facadeFixture(pairs: DeploymentPairPreview[], overrides: Partial<BatchDeploymentFacade> = {}): BatchDeploymentFacade {
  return {
    listTargets: async () => deploymentTargetsFixture(),
    preview: vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch(pairs)),
    commit: vi.fn<BatchDeploymentFacade["commit"]>(async (previewArg, selections) => selections.filter((selection) => !selection.exclude).map((selection) => {
      const facts = previewArg.pairs.find((candidate) => candidate.pairId === selection.pairId);
      return {
        skillId: facts?.skillId ?? "skill-pdf",
        displayName: facts?.skillDisplayName,
        targetId: facts?.logicalTargetIds[0] ?? "",
        label: facts?.targetLabel ?? "",
        status: "succeeded" as const,
        message: "deployment.results.status.message.succeeded",
      };
    })),
    ...overrides,
  };
}

async function renderDialog(facade: BatchDeploymentFacade, onCommitted?: (results: DeploymentResult[]) => void, tracker?: ReturnType<typeof createOperationTracker>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <DeploymentDialog
          facade={facade}
          onCommitted={onCommitted}
          skillId="skill-pdf"
          tracker={tracker}
          versionId="current"
        />
      </I18nextProvider>
    </MemoryRouter>,
  );
  return i18n;
}

it("supports one or many Agent targets and reports each pair result", async () => {
  const user = userEvent.setup();
  const pairs = [
    pair({ pairId: "skill-pdf:t-codex", logicalTargetIds: ["codex-cli"], targetLabel: "Codex CLI" }),
    pair({ pairId: "skill-pdf:t-claude", logicalTargetIds: ["claude-code"], targetLabel: "Claude Code" }),
  ];
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async (previewArg, selections) => selections.map((selection, index) => {
    const facts = previewArg.pairs.find((candidate) => candidate.pairId === selection.pairId);
    return {
      skillId: "skill-pdf",
      displayName: "PDF 抽取器",
      targetId: facts?.logicalTargetIds[0] ?? "",
      label: facts?.targetLabel ?? "",
      status: index === 0 ? ("succeeded" as const) : ("failed" as const),
      message: index === 0 ? "已部署" : "目标目录不可写",
    };
  }));
  const onCommitted = vi.fn();
  const facade = { ...facadeFixture(pairs), commit };

  await renderDialog(facade, onCommitted);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findAllByTestId("target-plan")).toHaveLength(2);
  expect(screen.getAllByText("Codex CLI").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "确认添加" }));
  expect(await screen.findAllByTestId("deployment-result")).toHaveLength(2);
  expect(onCommitted).toHaveBeenCalledWith([
    expect.objectContaining({ targetId: "codex-cli", status: "succeeded" }),
    expect.objectContaining({ targetId: "claude-code", status: "failed" }),
  ]);
});

it("keeps warning-level security findings visible while allowing dispatch", async () => {
  const user = userEvent.setup();
  const facade = facadeFixture([
    pair({ warnings: ["deployment.securityWarnings.warningAllowed"] }),
  ]);
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findByText("发现警告级安全问题，仍可派发。风险详情保留在安全检查中。"))
    .toBeVisible();
  const link = screen.getByRole("link", { name: "查看安全检查" });
  expect(link.getAttribute("href")).toBe("/library/skill-pdf/security");
  expect(screen.getByRole("button", { name: "确认添加" })).toBeEnabled();
});

it("shows the security page link for a danger-level pair blocked by preview", async () => {
  const user = userEvent.setup();
  const facade = facadeFixture([
    pair({ disposition: "blocked", mode: null, blockReason: "security_alert" }),
  ]);
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findByText("该版本存在尚未完全信任的危险级安全问题，暂不能派发。"))
    .toBeVisible();
  expect(screen.getByRole("link", { name: "查看安全检查" }).getAttribute("href"))
    .toBe("/library/skill-pdf/security");
});

it("offers only preview-approved conflict actions and requires shared-impact confirmation", async () => {
  const user = userEvent.setup();
  const conflict: NonNullable<DeploymentPairPreview["conflict"]> = {
    occupants: [{
      ownership: "managed",
      deployment_id: "old-deployment",
      skill_id: "old-skill",
      version_id: "old-version",
      skill_display_name: "旧版 PDF 技能",
      physical_target_id: "fs-codex",
      runtime_name: "pdf",
      target_path: "C:/Users/demo/.codex/skills",
      consumers: ["old-deployment"],
      entry_identity: "entry-1",
      content_fingerprint: "sha256:old",
    }],
    shared_target: true,
    shared_consumers_complete: true,
    shared_consumers: [{
      kind: "agent",
      consumer_id: "agent:codex",
      display_name: "Codex CLI",
      logical_target_ids: ["codex-cli"],
      active_deployment_ids: ["old-deployment"],
    }],
    shared_consumer_fingerprint: "sha256:consumers",
    available_actions: ["replace_target", "skip"],
    default_action: "skip",
  };
  const pairPreview = pair({
    pairId: "skill-pdf:fs-codex",
    logicalTargetIds: ["codex-cli"],
    disposition: "blocked",
    blockReason: "target_occupied",
    mode: null,
    conflict,
  });
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async () => []);
  const facade = facadeFixture([pairPreview], { commit });
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findByText("Codex CLI", { selector: ".sh-deployment-impact-card__targets strong" })).toBeVisible();
  expect(screen.queryByRole("radio", { name: /换名派发/ })).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /跳过/ })).toBeChecked();
  expect(screen.getByText(/Agent：Codex CLI/)).toBeVisible();

  await user.click(screen.getByRole("radio", { name: /替换目标/ }));
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /已查看.*共享目录/ }));
  await user.click(screen.getByRole("button", { name: "确认添加" }));

  expect(commit).toHaveBeenCalledWith(
    expect.anything(),
    [expect.objectContaining({
      pairId: "skill-pdf:fs-codex",
      confirmSharedTarget: true,
      conflictDecision: expect.objectContaining({ action: "replace_target" }),
    })],
    expect.any(Function),
  );
});

it("resets conflict choices when a new preview replaces the old one", async () => {
  const user = userEvent.setup();
  const firstPreview = pair({
    pairId: "skill-pdf:fs-codex",
    logicalTargetIds: ["codex-cli"],
    disposition: "blocked",
    blockReason: "target_occupied",
    mode: null,
    conflict: {
      occupants: [],
      shared_target: false,
      shared_consumers_complete: false,
      shared_consumers: [],
      shared_consumer_fingerprint: "",
      available_actions: ["replace_target", "skip"],
      default_action: "skip",
    },
  });
  const facade = facadeFixture([firstPreview]);
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("radio", { name: /替换目标/ }));
  // 目标选择始终保留在页面；切换并恢复另一个目标会生成新预览，
  // 验证新预览不会继承之前针对旧事实作出的冲突选择。
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findByRole("radio", { name: /跳过/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /替换目标/ })).not.toBeChecked();
});

it("blocks an invalid or inconsistent rename before submitting the batch", async () => {
  const user = userEvent.setup();
  const conflictFor = (targetId: string) => pair({
    pairId: `skill-pdf:${targetId}`,
    logicalTargetIds: [targetId],
    targetLabel: targetId === "codex-cli" ? "Codex CLI" : "Claude Code",
    disposition: "blocked",
    blockReason: "target_occupied",
    mode: null,
    conflict: {
      occupants: [],
      shared_target: false,
      shared_consumers_complete: false,
      shared_consumers: [],
      shared_consumer_fingerprint: "",
      available_actions: ["rename_and_deploy", "skip"],
      default_action: "skip",
    },
  });
  const facade = facadeFixture([conflictFor("codex-cli"), conflictFor("claude-code")]);
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("radio", { name: /换名后派发.*Codex CLI/ }));
  await user.click(screen.getByRole("radio", { name: /换名后派发.*Claude Code/ }));
  await user.type(screen.getByRole("textbox", { name: /新名称.*Codex CLI/ }), "pdf-v2");
  await user.type(screen.getByRole("textbox", { name: /新名称.*Claude Code/ }), "pdf-v3");

  expect(await screen.findAllByText(/多个目标必须使用相同的新名称/)).toHaveLength(2);
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
  expect(facade.commit).not.toHaveBeenCalled();
});

it("shows an empty state after target discovery completes", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => [],
    preview: vi.fn(),
    commit: vi.fn(),
  };

  render(
    <I18nextProvider i18n={i18n}>
      <DeploymentDialog skillId="skill-pdf" versionId="current" facade={facade} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("未发现可写入的 Agent 目标")).toBeInTheDocument();
  expect(screen.queryByText("正在加载目标")).not.toBeInTheDocument();
});

it("does not treat a target with no directory status as pending creation", async () => {
  const target = {
    ...deploymentTargetsFixture()[0],
    available: false,
    directoryStatus: null as unknown as DeploymentTarget["directoryStatus"],
    physicalIdentityVerified: false,
  };
  const facade = facadeFixture([], { listTargets: async () => [target] });

  await renderDialog(facade);

  expect(await screen.findByText("路径不可用")).toBeVisible();
  expect(screen.queryByText("待创建")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "创建并加入派发" })).not.toBeInTheDocument();
});

it("offers registered custom agents as selectable targets with brand presentation (2026-09-30)", async () => {
  // 2026-09-30 裁决：自定义 Agent 与内置 Agent 同规则进入部署目标——
  // 可勾选、以统一卡片模型的品牌呈现，内部 id 不进界面。
  const facade = facadeFixture([], { listTargets: async () => [customAgentDeploymentTargetFixture()] });

  await renderDialog(facade);

  const checkbox = await screen.findByRole("checkbox", { name: /Acme/ });
  expect(checkbox).toBeEnabled();
  expect(screen.queryByText("custom-acme")).not.toBeInTheDocument();
});

it("offers creation only when a target is explicitly missing", async () => {
  const target = {
    ...deploymentTargetsFixture()[0],
    available: false,
    directoryStatus: "missing" as const,
    physicalIdentityVerified: false,
  };
  const facade = facadeFixture([], {
    listTargets: async () => [target],
    ensureTargetDirectory: vi.fn(async () => undefined),
  });

  await renderDialog(facade);

  expect(await screen.findByText("待创建")).toBeVisible();
  const createAndDispatch = screen.getByRole("button", { name: "创建并加入派发" });
  expect(createAndDispatch).toBeVisible();
  expect(createAndDispatch).toHaveClass("sh-button--primary");
});

function cardModelFixture(memberIds: string[]): AgentCardModel {
  return {
    id: `agent_native:test:${memberIds.join("+")}`,
    brand: "OpenAI",
    brandLabel: "OpenAI",
    kinds: ["cli"],
    directories: [],
    sharedDirectory: false,
    supportsSharedDirectory: false,
    sharedAgentBrands: [],
    sharedAgentBrandKinds: {},
    builtin: false,
    readOnly: false,
    supportedModes: ["managed_copy"],
    deploymentStatus: "not_deployed",
    detailTarget: memberIds[0] ?? "",
    members: memberIds.map((id) => ({ id })) as AgentCardModel["members"],
  };
}

function mergedCardTargets(): DeploymentTarget[] {
  const model = cardModelFixture(["codex-cli", "codex-desktop"]);
  return [
    { ...deploymentTargetsFixture()[0], id: "codex-cli", agentClientId: "codex.code", cardModel: model },
    { ...deploymentTargetsFixture()[0], id: "codex-desktop", label: "Codex Desktop", agentClientId: "codex.desktop", cardModel: model, modes: ["managed_copy"] },
  ];
}

it("selecting a merged Agent card submits every selectable member (DEV-106)", async () => {
  const user = userEvent.setup();
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch([]));
  const facade: BatchDeploymentFacade = { listTargets: async () => mergedCardTargets(), preview, commit: vi.fn() };

  await renderDialog(facade);

  // 合卡只渲染一个选择框；勾选即选中其全部可选成员。
  expect(await screen.findAllByRole("checkbox")).toHaveLength(1);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(preview).toHaveBeenCalledWith(
    [expect.objectContaining({ skillId: "skill-pdf", targetIds: ["codex-cli", "codex-desktop"] })],
    undefined,
  );
});

it("disables mode preferences that the selected targets do not all support (DEV-106)", async () => {
  const user = userEvent.setup();
  const copyOnly = { ...deploymentTargetsFixture()[0], id: "copy-only", label: "Copy Only", agentClientId: "copy.only", modes: ["managed_copy" as const] };
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch([]));
  const facade: BatchDeploymentFacade = { listTargets: async () => [copyOnly], preview, commit: vi.fn() };

  await renderDialog(facade);

  // 未选择目标时链接/复制偏好同样不可选；自动推荐始终可用。
  await screen.findByRole("option", { name: "链接" });
  expect((screen.getByRole("option", { name: "链接" }) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByRole("option", { name: "完整拷贝" }) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByRole("option", { name: "自动选择方式" }) as HTMLOptionElement).disabled).toBe(false);

  await user.click(await screen.findByRole("checkbox"));
  expect((screen.getByRole("option", { name: "链接" }) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByRole("option", { name: "完整拷贝" }) as HTMLOptionElement).disabled).toBe(false);
});

it("offers only copy preference for a shared directory target", async () => {
  const user = userEvent.setup();
  const shared = {
    ...deploymentTargetsFixture()[0],
    id: "shared-skills",
    label: "共享目录",
    sharedDirectory: true,
    modes: ["managed_copy" as const],
  };
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch([]));
  const facade: BatchDeploymentFacade = { listTargets: async () => [shared], preview, commit: vi.fn() };

  await renderDialog(facade);
  const checkbox = await screen.findByRole("checkbox", { name: "Agent共享目录" });
  const linkOption = screen.getByRole("option", { name: "链接" }) as HTMLOptionElement;
  const copyOption = screen.getByRole("option", { name: "完整拷贝" }) as HTMLOptionElement;
  await user.click(checkbox);

  expect(linkOption.disabled).toBe(true);
  expect(copyOption.disabled).toBe(false);
  await user.selectOptions(screen.getByRole("combobox", { name: "派发方式" }), "copy");
  await user.click(screen.getByRole("button", { name: "预览" }));
  expect(preview).toHaveBeenCalledWith(
    [expect.objectContaining({ targetIds: ["shared-skills"], preference: "copy" })],
    undefined,
  );
});

it("retries every selectable member of a failed merged card (DEV-106)", async () => {
  const user = userEvent.setup();
  const pairs = [pair({ pairId: "skill-pdf:codex", logicalTargetIds: ["codex-cli", "codex-desktop"], targetLabel: "OpenAI" })];
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch(pairs));
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async () => [{
    skillId: "skill-pdf",
    targetId: "codex-cli",
    label: "OpenAI",
    status: "failed" as const,
    message: "目标目录不可写",
  }]);
  const facade: BatchDeploymentFacade = { listTargets: async () => mergedCardTargets(), preview, commit };

  await renderDialog(facade);

  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));
  await user.click(await screen.findByRole("button", { name: "重试失败目标" }));

  // 重试按合卡语义重新选整卡：合并 pair 的失败不能只重选首个成员。
  await user.click(await screen.findByRole("button", { name: "预览" }));
  expect(preview).toHaveBeenLastCalledWith(
    [expect.objectContaining({ targetIds: ["codex-cli", "codex-desktop"] })],
    undefined,
  );
});

it("sends the user preference instead of an implementation mode (14.11)", async () => {
  const user = userEvent.setup();
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch([]));
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture(), preview, commit: vi.fn() };

  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.selectOptions(screen.getByLabelText("派发方式"), "copy");
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(preview).toHaveBeenCalledWith(
    [expect.objectContaining({ skillId: "skill-pdf", targetIds: ["codex-cli"], preference: "copy" })],
    undefined,
  );
});

it("requires explicit fallback confirmation, then a final re-preview, before commit (14.3/14.14)", async () => {
  const user = userEvent.setup();
  const FINGERPRINT = "fp-stable";
  const confirmPair = (preserved: boolean): DeploymentPairPreview => ({
    pairId: "skill-pdf:t1",
    skillId: "skill-pdf",
    skillDisplayName: "PDF 抽取器",
    logicalTargetIds: ["codex-cli"],
    runtimeName: "pdf",
    targetLabel: "Codex CLI",
    targetPath: "C:/Users/demo/.codex/skills",
    destinationPath: "C:/Users/demo/.codex/skills/pdf",
    preference: "link",
    disposition: "recommend_copy",
    mode: null,
    fallbackMode: "managed_copy",
    blockReason: "link_permission_unavailable",
    warnings: [],
    confirmationPreserved: preserved,
    confirmationFingerprint: FINGERPRINT,
    technicalError: null,
  });
  let call = 0;
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (_items, context) => {
    call += 1;
    const preserved = call > 1 && context?.confirmations?.["skill-pdf:t1"] === FINGERPRINT;
    return previewBatch([confirmPair(preserved)], preserved ? ["skill-pdf:t1"] : []);
  });
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async () => []);
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture(), preview, commit };

  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  // Link 被阻止：给出用户可理解的原因与完整拷贝派发选择。
  expect(within(plan).getByText(/当前账户无权创建链接/)).toBeVisible();

  // 未确认前提交不可用；确认动作的下一步是「重新生成最终预览」。
  await user.click(within(plan).getByRole("checkbox", { name: /PDF 抽取器 · Codex CLI/ }));
  await user.click(screen.getByRole("button", { name: "重新生成最终预览" }));

  // 确认保留：显示最终复制影响并开放提交。
  const finalPlan = await screen.findByRole("region", { name: /添加计划/ });
  expect(within(finalPlan).getByText(/已确认按完整拷贝派发/)).toBeVisible();
  const commitButton = await screen.findByRole("button", { name: "确认添加" });
  expect(commitButton).toBeEnabled();
  await user.click(commitButton);
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ previewId: expect.any(String) }), [
    expect.objectContaining({ pairId: "skill-pdf:t1", confirmFallback: true, exclude: false }),
  ], expect.anything());
});

it("renders blocked reasons in user-facing words and keeps raw causes in technical details (14.4)", async () => {
  const user = userEvent.setup();
  const facade = facadeFixture([
    pair({ pairId: "skill-pdf:t1", disposition: "blocked", mode: null, blockReason: "link_permission_unavailable", technicalError: { code: "deployment.symlink_not_supported", severity: "error", params: { path: "C:/t" }, actions: [] } }),
    pair({ pairId: "skill-pdf:t2", logicalTargetIds: ["claude-code"], targetLabel: "Claude Code", disposition: "blocked", mode: null, blockReason: "link_filesystem_unsupported" }),
  ]);

  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  expect(within(plan).getByText(/当前账户无权创建链接/)).toBeVisible();
  expect(within(plan).getByText(/此磁盘或分区不支持创建链接/)).toBeVisible();
  // DEV-99：原始 code/内部 ID 全面退出界面——技术详情折叠区也不得展示。
  expect(within(plan).queryByText("deployment.symlink_not_supported")).toBeNull();
  expect(within(plan).queryByText("Skill ID")).toBeNull();
  expect(within(plan).queryByText("部署条目")).toBeNull();
  // 全部受阻：提交不可用。
  expect(screen.getByRole("button", { name: "确认添加" })).toBeDisabled();
});

it("keeps the preview failure alert visible and the selection recoverable", async () => {
  const user = userEvent.setup();
  let failPreview = true;
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => {
    if (failPreview) throw new Error("deployment.target_not_writable");
    return previewBatch([]);
  });
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture(), preview, commit: vi.fn() };
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 失败态：告警与目标选择并存，用户可以直接调整选择后重试预览。
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByLabelText("Codex CLI")).toBeEnabled();
  expect(screen.getByLabelText("Claude Code")).toBeEnabled();

  failPreview = false;
  await user.click(screen.getByLabelText("Claude Code"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findByRole("button", { name: "确认添加" })).toBeDisabled(); // 空 pair 集无可执行项
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(preview).toHaveBeenCalledTimes(2);
});

it("returns keyboard focus to the deploy flow heading across phase changes", async () => {
  const user = userEvent.setup();
  const facade = facadeFixture([pair({ pairId: "skill-pdf:t1" })]);
  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 阶段切换时原主操作卸载；焦点必须落回流程标题，不能丢失到 body。
  await screen.findByRole("button", { name: "确认添加" });
  expect(screen.getByRole("heading", { name: "先预览，再修改 Agent 目标" })).toHaveFocus();
});

describe("DeploymentDialog 与统一执行桥", () => {
  it("reports the commit to the unified tracker: running in flight, partial finish, operation record correlation", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    let resolveCommit!: (value: BatchDeploymentResult[]) => void;
    const pairs = [
      pair({ pairId: "skill-pdf:t-codex", logicalTargetIds: ["codex-cli"], targetLabel: "Codex CLI" }),
      pair({ pairId: "skill-pdf:t-claude", logicalTargetIds: ["claude-code"], targetLabel: "Claude Code" }),
    ];
    const commit = vi.fn<BatchDeploymentFacade["commit"]>((_preview, _selections, onProgress) => new Promise((resolve) => {
      resolveCommit = (value) => {
        onProgress?.(2);
        resolve(value);
      };
    }));
    const facade = { ...facadeFixture(pairs), commit };
    await renderDialog(facade, undefined, tracker);

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByLabelText("Claude Code"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));

    // 提交在途：统一 tracker 出现 running 任务（顶栏同源投影）。
    const [inFlight] = tracker.getSnapshot();
    expect(inFlight.status).toBe("running");
    expect(inFlight.kind).toBe("deploy");
    expect(inFlight.label).toBe("添加到 Agent/项目");
    expect(inFlight.total).toBe(2);

    resolveCommit([
      { skillId: "skill-pdf", targetId: "codex-cli", label: "Codex CLI", status: "succeeded", message: "deployment.results.status.message.succeeded", operationId: "op-deploy-1" },
      { skillId: "skill-pdf", targetId: "claude-code", label: "Claude Code", status: "failed", message: "目标目录不可写", operationId: "op-deploy-1" },
    ]);
    expect(await screen.findAllByTestId("deployment-result")).toHaveLength(2);

    const [finished] = tracker.getSnapshot();
    expect(finished.status).toBe("partial");
    expect(finished.resultSummary).toEqual({ succeeded: 1, failed: 1, skipped: 0 });
    // 三端同一 operation id：前端投影关联持久化记录并派生深链。
    expect(finished.operationId).toBe("op-deploy-1");
    expect(finished.targetHref).toBe("/operations/op-deploy-1");
  });

  it("records commit failures on the tracker and keeps the page error without swallowing the exception", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const facade = facadeFixture([pair({ pairId: "skill-pdf:t1" })], {
      commit: vi.fn<BatchDeploymentFacade["commit"]>(async () => {
        throw new Error("deployment.plan_stale");
      }),
    });
    await renderDialog(facade, undefined, tracker);

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));

    // 页面错误不吞掉：告警照常渲染，tracker 同步落 failed 终态。
    expect(await screen.findByRole("alert")).toBeVisible();
    const [failed] = tracker.getSnapshot();
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("deployment.plan_stale");
  });
});

it("offers a manage-relations deep link back to the governance workbench", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture(),
    preview: vi.fn(),
    commit: vi.fn(),
  };
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <DeploymentDialog
          facade={facade}
          manageRelationsHref="/relationships/governance?from=library&skillId=skill-pdf"
          skillId="skill-pdf"
          versionId="current"
        />
      </I18nextProvider>
    </MemoryRouter>,
  );

  const link = await screen.findByTestId("manage-relations-link");
  expect(link.textContent).toContain("管理关系");
  expect(link.getAttribute("href")).toBe(
    "/relationships/governance?from=library&skillId=skill-pdf",
  );
});

// W3-1（FB-003 裁决第 1 节）：派发被安全预警拒绝时不留死胡同——错误文案给
// 出处理入口指引，并提供直达详情安全页与待办的处理链接。
it("guides to the security page and pending work when dispatch is blocked by a security alert", async () => {
  const user = userEvent.setup();
  const blocked = { code: "deployment.security_alert_blocked", severity: "error", params: {}, actions: [] };
  const facade = facadeFixture([], {
    preview: vi.fn<BatchDeploymentFacade["preview"]>(async () => { throw blocked; }),
  });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/library/skill-pdf/deploy"]}>
        <Routes>
          <Route element={<DeploymentDialog facade={facade} skillId="skill-pdf" versionId="current" />} path="/library/skill-pdf/deploy" />
          <Route element={<p>Security route</p>} path="/library/skill-pdf/security" />
          <Route element={<p>Pending route</p>} path="/pending" />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(await screen.findByText(/尚未完全信任的危险级安全问题，处理前不可派发/)).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: "前往安全页处理" }));
  expect(await screen.findByText("Security route")).toBeVisible();
});
