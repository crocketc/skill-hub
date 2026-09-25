import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import {
  deploymentTargetsFixture,
  type BatchDeploymentFacade,
  type BatchDeploymentResult,
  type DeploymentPairPreview,
  type DeploymentPreviewBatch,
  type DeploymentResult,
} from "./api";
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
    <I18nextProvider i18n={i18n}>
      <DeploymentDialog
        facade={facade}
        onCommitted={onCommitted}
        skillId="skill-pdf"
        tracker={tracker}
        versionId="current"
      />
    </I18nextProvider>,
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

it("sends the user preference instead of an implementation mode (14.11)", async () => {
  const user = userEvent.setup();
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch([]));
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture(), preview, commit: vi.fn() };

  await renderDialog(facade);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.selectOptions(screen.getByLabelText("部署方式"), "copy");
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
  // Link 被阻止：给出用户可理解的原因与「改用复制部署」的选择。
  expect(within(plan).getByText(/当前账户无权创建链接部署/)).toBeVisible();

  // 未确认前提交不可用；确认动作的下一步是「重新生成最终预览」。
  await user.click(within(plan).getByRole("checkbox", { name: /PDF 抽取器 · Codex CLI/ }));
  await user.click(screen.getByRole("button", { name: "重新生成最终预览" }));

  // 确认保留：显示最终复制影响并开放提交。
  const finalPlan = await screen.findByRole("region", { name: /添加计划/ });
  expect(within(finalPlan).getByText(/已确认改用复制/)).toBeVisible();
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
  expect(within(plan).getByText(/当前账户无权创建链接部署/)).toBeVisible();
  expect(within(plan).getByText(/此文件的磁盘或分区不支持链接部署/)).toBeVisible();
  // 原始 code 不进首屏，只在可展开的技术详情里。
  const raw = within(plan).getByText("deployment.symlink_not_supported");
  expect(raw.closest("details")).not.toBeNull();
  expect(raw).not.toBeVisible();
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
