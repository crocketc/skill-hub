import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import { BatchDeploymentPage } from "./BatchDeploymentPage";
import {
  deploymentTargetsFixture,
  type BatchDeploymentFacade,
  type BatchDeploymentResult,
  type DeploymentPairPreview,
  type DeploymentPreference,
  type DeploymentPreviewBatch,
  type DeploymentTarget,
} from "./api";

async function renderBatchPage(facade: BatchDeploymentFacade, skillIds: string[], initialEntry = "/deploy") {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <BatchDeploymentPage facade={facade} skillIds={skillIds} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

let pairSeq = 0;

function pair(overrides: Partial<DeploymentPairPreview> = {}): DeploymentPairPreview {
  pairSeq += 1;
  return {
    pairId: `skill-${pairSeq}:fs-target`,
    skillId: `skill-${pairSeq}`,
    skillDisplayName: `Skill ${pairSeq}`,
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

/** 默认 facade：两个可用目标，preview 原样回放注入的 pairs。 */
function batchFacade(response: (items: Parameters<BatchDeploymentFacade["preview"]>[0], context: Parameters<BatchDeploymentFacade["preview"]>[1]) => DeploymentPreviewBatch, overrides: Partial<BatchDeploymentFacade> = {}): BatchDeploymentFacade {
  const targets = deploymentTargetsFixture().slice(0, 2);
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (items, context) => response(items, context));
  return {
    listTargets: async () => targets,
    preview,
    commit: vi.fn<BatchDeploymentFacade["commit"]>(async (previewArg, selections) => selections.map((selection) => {
      const facts = previewArg.pairs.find((candidate) => candidate.pairId === selection.pairId);
      return {
        skillId: facts?.skillId ?? "",
        displayName: facts?.skillDisplayName,
        targetId: facts?.logicalTargetIds[0] ?? "",
        label: facts?.targetLabel ?? "",
        status: selection.exclude ? ("skipped" as const) : ("succeeded" as const),
        message: "deployment.results.status.message.succeeded",
      };
    })),
    ...overrides,
  };
}

const allCopyPairs = (targetIds: string[], skillCount = 2): DeploymentPairPreview[] =>
  Array.from({ length: skillCount }, (_, index) => pair({
    skillId: `skill-${index + 1}`,
    skillDisplayName: `Skill ${index + 1}`,
    pairId: `skill-${index + 1}:${targetIds[index] ?? targetIds[0]}`,
    logicalTargetIds: [targetIds[index] ?? targetIds[0]],
  }));

it("hides unavailable targets from the default selection list (DEV-11)", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture(),
    preview: async () => previewBatch([]),
    commit: async () => [],
  };
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  // 可用目标可选；不可用目标不出现在默认列表（文案承诺"已发现且可写"）。
  expect(await screen.findByLabelText("Codex CLI")).toBeVisible();
  expect(screen.queryByLabelText("Read-only Agent")).not.toBeInTheDocument();
});

it("renders selectable deployment targets as compact cards with full-path hints (DEV-82)", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture().slice(0, 2);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => targets,
    preview: async () => previewBatch([]),
    commit: async () => [],
  };
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  const grid = await screen.findByTestId("deployment-target-grid");
  expect(grid).toHaveClass("sh-deployment-targets");
  const cards = within(grid).getAllByTestId("deployment-target-card");
  expect(cards).toHaveLength(2);
  expect(cards[0]).toHaveClass("sh-deployment-target-card");
  expect(within(cards[0]).getByTitle("C:\\Users\\demo\\.codex\\skills")).toHaveTextContent("C:\\Users\\demo\\.codex\\skills");
});

it("previews the whole batch in one call and groups pair dispositions for explicit commit (14.5)", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  // 四个 pair 覆盖四类处置：按所选执行、建议复制、无需变更、无法执行。
  const pairs = [
    pair({ skillId: "skill-1", skillDisplayName: "Skill 1", pairId: "s1:t1", disposition: "selected_mode", mode: "symbolic_link" }),
    pair({ skillId: "skill-2", skillDisplayName: "Skill 2", pairId: "s2:t1", disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy", blockReason: "link_permission_unavailable" }),
    pair({ skillId: "skill-3", skillDisplayName: "Skill 3", pairId: "s3:t1", disposition: "no_change", mode: "managed_copy" }),
    pair({ skillId: "skill-4", skillDisplayName: "Skill 4", pairId: "s4:t1", disposition: "blocked", mode: null, blockReason: "target_occupied" }),
  ];
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch(pairs));
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture().slice(0, 1), preview, commit: async () => [] };

  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf", "skill-docx"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 一次调用携带全部 Skill 与用户偏好，不再按 Skill 逐个查询整计划。
  expect(preview).toHaveBeenCalledWith(
    [expect.objectContaining({ skillId: "skill-pdf", targetIds: ["codex-cli"], preference: "automatic" }),
      expect.objectContaining({ skillId: "skill-docx", targetIds: ["codex-cli"], preference: "automatic" })],
    undefined,
  );

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  // 四组按处置分组呈现，每组标题携带 pair 数量。
  expect(within(plan).getByRole("heading", { name: /按所选方式执行/ })).toHaveTextContent("1");
  expect(within(plan).getByRole("heading", { name: /建议改用复制部署/ })).toHaveTextContent("1");
  expect(within(plan).getByRole("heading", { name: /无需变更/ })).toHaveTextContent("1");
  expect(within(plan).getByRole("heading", { name: /无法执行/ })).toHaveTextContent("1");
});

it("sends the selected preference instead of an implementation mode (14.11)", async () => {
  const user = userEvent.setup();
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch(allCopyPairs(["codex-cli"], 1)));
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture().slice(0, 1), preview, commit: async () => [] };

  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.selectOptions(screen.getByLabelText("部署方式"), "link");
  await user.click(screen.getByRole("button", { name: "预览" }));

  expect(preview).toHaveBeenCalledWith(
    [expect.objectContaining({ preference: "link" as DeploymentPreference })],
    undefined,
  );
});

it("requires group confirmation per pair and never merges different impacts into one group (14.6)", async () => {
  const user = userEvent.setup();
  // 同为「建议改用复制」，但回退落点不同（复制 vs 阻断原因不同）→ 两组。
  const pairs = [
    pair({ skillId: "skill-1", skillDisplayName: "Skill 1", pairId: "s1:t1", disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy", blockReason: "link_permission_unavailable" }),
    pair({ skillId: "skill-2", skillDisplayName: "Skill 2", pairId: "s2:t1", disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy", blockReason: "link_filesystem_unsupported" }),
  ];
  const facade = batchFacade(() => previewBatch(pairs));

  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);
  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  const groups = within(plan).getAllByTestId("disposition-group");
  expect(groups).toHaveLength(2);
  // 组内全选 + 逐项取消：勾选组全选后，单个 pair 可取消。
  const group = groups.find((candidate) => within(candidate).queryByRole("checkbox", { name: /Skill 1 · Codex CLI/ }));
  expect(group).toBeDefined();
  const selectAll = within(group!).getByRole("checkbox", { name: /确认本组全部改用复制/ });
  await user.click(selectAll);
  const rowCheckbox = within(group!).getByRole("checkbox", { name: /Skill 1 · Codex CLI/ });
  expect(rowCheckbox).toBeChecked();
  await user.click(rowCheckbox);
  expect(rowCheckbox).not.toBeChecked();
  expect(selectAll).not.toBeChecked();
});

it("asks the backend to re-preview with held fingerprints and honors preserved confirmations (14.7/14.14)", async () => {
  const user = userEvent.setup();
  const recommendPair = (fingerprint: string, preserved: boolean) => pair({
    skillId: "skill-1", skillDisplayName: "Skill 1", pairId: "s1:t1",
    disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy",
    blockReason: "link_permission_unavailable",
    confirmationFingerprint: fingerprint, confirmationPreserved: preserved,
  });
  let call = 0;
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (_items, context) => {
    call += 1;
    if (call === 1) return previewBatch([recommendPair("fp-1", false)]);
    // 第二次：后端重算指纹，与客户端持有的一致 → preserved。
    return previewBatch([recommendPair("fp-1", context?.confirmations?.["s1:t1"] === "fp-1")], ["s1:t1"]);
  });
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture().slice(0, 1), preview, commit: async () => [] };

  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 未确认回退前：提交禁用，主操作是「重新生成最终预览」，不直接绑定 commit。
  const plan = await screen.findByRole("region", { name: /添加计划/ });
  const rowCheckbox = within(plan).getByRole("checkbox", { name: /Skill 1 · Codex CLI/ });
  await user.click(rowCheckbox);

  const regenerate = screen.getByRole("button", { name: "重新生成最终预览" });
  await user.click(regenerate);

  // 重预览携带客户端持有的指纹；确认由后端显式判定仍然有效。
  await waitFor(() => expect(preview).toHaveBeenNthCalledWith(2,
    [expect.objectContaining({ skillId: "skill-pdf" })],
    { confirmations: { "s1:t1": "fp-1" }, exclusions: [] },
  ));
  expect(await screen.findByRole("button", { name: "确认添加" })).toBeEnabled();
  const preserved = await screen.findByTestId("disposition-group");
  expect(within(preserved).getByText(/已确认改用复制/)).toBeVisible();
});

it("re-demands confirmation when the backend reports the fingerprint drifted (14.7)", async () => {
  const user = userEvent.setup();
  let call = 0;
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async (_items, context) => {
    call += 1;
    if (call === 1) {
      return previewBatch([pair({
        skillId: "skill-1", skillDisplayName: "Skill 1", pairId: "s1:t1",
        disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy",
        blockReason: "link_permission_unavailable", confirmationFingerprint: "fp-1",
      })]);
    }
    // 目标事实变化：指纹重算后与持有值不同 → 确认失效。
    return previewBatch([pair({
      skillId: "skill-1", skillDisplayName: "Skill 1", pairId: "s1:t1",
      disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy",
      blockReason: "link_permission_unavailable", confirmationFingerprint: "fp-2",
      confirmationPreserved: context?.confirmations?.["s1:t1"] === "fp-2",
    })]);
  });
  const facade: BatchDeploymentFacade = { listTargets: async () => deploymentTargetsFixture().slice(0, 1), preview, commit: async () => [] };

  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  const plan = await screen.findByRole("region", { name: /添加计划/ });
  await user.click(within(plan).getByRole("checkbox", { name: /Skill 1 · Codex CLI/ }));
  await user.click(screen.getByRole("button", { name: "重新生成最终预览" }));

  // 确认失效：提交动作不出现，主操作回到「重新生成最终预览」重新要求用户处理。
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("button", { name: "重新生成最终预览" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "确认添加" })).not.toBeInTheDocument();
});

it("counts the final summary across link, copy, no-change, excluded and still-blocked pairs (14.8)", async () => {
  const user = userEvent.setup();
  const pairs = [
    pair({ pairId: "s1:t1", skillDisplayName: "Skill 1", disposition: "selected_mode", mode: "symbolic_link" }),
    pair({ pairId: "s2:t1", skillDisplayName: "Skill 2", disposition: "selected_mode", mode: "managed_copy" }),
    pair({ pairId: "s3:t1", skillDisplayName: "Skill 3", disposition: "no_change", mode: "managed_copy" }),
    pair({ pairId: "s4:t1", skillDisplayName: "Skill 4", disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy", blockReason: "link_permission_unavailable", confirmationPreserved: true }),
    pair({ pairId: "s5:t1", skillDisplayName: "Skill 5", disposition: "recommend_copy", mode: null, fallbackMode: "managed_copy", blockReason: "link_filesystem_unsupported" }),
    pair({ pairId: "s6:t1", skillDisplayName: "Skill 6", disposition: "blocked", mode: null, blockReason: "target_occupied" }),
  ];
  const facade = batchFacade(() => previewBatch(pairs, ["s4:t1"]));

  await renderBatchPage(facade, ["skill-pdf"]);
  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  const summary = within(plan).getByRole("status");
  // 链接 1、复制 2（后端判定保留的确认计入复制）、无需变更 1；已排除 0；仍受阻 2。
  expect(summary).toHaveTextContent("链接部署 1");
  expect(summary).toHaveTextContent("复制部署 2");
  expect(summary).toHaveTextContent("无需变更 1");
  expect(summary).toHaveTextContent("已排除 0");
  expect(summary).toHaveTextContent("仍受阻 2");

  // 排除一个可执行 pair 后计数即时反映；仍受阻不消失。
  await user.click(within(plan).getByRole("checkbox", { name: /Skill 1 · Codex CLI/ }));
  expect(within(plan).getByRole("status")).toHaveTextContent("已排除 1");
});

it("submits selections with exclusions and still-blocked pairs, then reports every outcome (14.8/14.9)", async () => {
  const user = userEvent.setup();
  const pairs = [
    pair({ pairId: "s1:t1", skillId: "skill-1", skillDisplayName: "Skill 1", disposition: "selected_mode", mode: "managed_copy" }),
    pair({ pairId: "s2:t1", skillId: "skill-2", skillDisplayName: "Skill 2", disposition: "blocked", mode: null, blockReason: "target_occupied" }),
  ];
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async (previewArg, selections) => selections.map((selection) => {
    const facts = previewArg.pairs.find((candidate) => candidate.pairId === selection.pairId);
    return {
      skillId: facts?.skillId ?? "",
      displayName: facts?.skillDisplayName,
      targetId: facts?.logicalTargetIds[0] ?? "",
      label: facts?.targetLabel ?? "",
      status: selection.exclude ? ("skipped" as const) : (facts?.disposition === "blocked" ? ("failed" as const) : ("succeeded" as const)),
      message: "结果说明",
    };
  }));
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture().slice(0, 1),
    preview: async () => previewBatch(pairs),
    commit,
  };

  await renderBatchPage(facade, ["skill-pdf"]);
  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 仍有受阻 pair，但可执行项继续：提交可用（非原子批次）。
  const commitButton = await screen.findByRole("button", { name: "确认添加" });
  expect(commitButton).toBeEnabled();
  await user.click(commitButton);

  // 阻断 pair 不排除（结果面仍报告 blocked）；可执行 pair 以 exclude=false 提交。
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ previewId: expect.any(String) }), [
    expect.objectContaining({ pairId: "s1:t1", confirmFallback: false, exclude: false }),
    expect.objectContaining({ pairId: "s2:t1", confirmFallback: false, exclude: false }),
  ], expect.anything());

  const summary = await screen.findByTestId("batch-summary");
  expect(summary).toHaveTextContent("成功 1");
  expect(summary).toHaveTextContent("失败 1");
});

it("keeps excluded pairs out of the commit execution and reports them as skipped (14.15)", async () => {
  const user = userEvent.setup();
  const pairs = [
    pair({ pairId: "s1:t1", skillId: "skill-1", skillDisplayName: "Skill 1", disposition: "selected_mode", mode: "managed_copy" }),
    pair({ pairId: "s2:t1", skillId: "skill-2", skillDisplayName: "Skill 2", disposition: "no_change", mode: "managed_copy" }),
  ];
  const commit = vi.fn<BatchDeploymentFacade["commit"]>(async (previewArg, selections) => selections.map((selection) => {
    const facts = previewArg.pairs.find((candidate) => candidate.pairId === selection.pairId);
    return {
      skillId: facts?.skillId ?? "",
      targetId: facts?.logicalTargetIds[0] ?? "",
      label: facts?.targetLabel ?? "",
      status: selection.exclude ? ("skipped" as const) : ("succeeded" as const),
      message: "结果说明",
    };
  }));
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture().slice(0, 1),
    preview: async () => previewBatch(pairs),
    commit,
  };

  await renderBatchPage(facade, ["skill-pdf"]);
  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  // 逐项取消一个 pair：重新生成最终预览后提交。
  await user.click(within(plan).getByRole("checkbox", { name: /Skill 2 · Codex CLI/ }));
  await user.click(screen.getByRole("button", { name: "重新生成最终预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));

  expect(commit).toHaveBeenCalledWith(expect.anything(), [
    expect.objectContaining({ pairId: "s1:t1", exclude: false }),
    expect.objectContaining({ pairId: "s2:t1", exclude: true }),
  ], expect.anything());
});

it("expands a selected project into its linked agent targets", async () => {
  const user = userEvent.setup();
  const agent: DeploymentTarget = { id: "logical-agent-1", label: "Codex CLI", path: "C:/codex/skills", available: true, physicalId: "p1", modes: ["managed_copy"] };
  const project: DeploymentTarget = { id: "project-1", label: "我的项目", path: "D:/proj", available: true, physicalId: "p2", modes: ["managed_copy"] };
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch([]));
  const facade: BatchDeploymentFacade = {
    listTargets: async () => [agent, project],
    preview,
    commit: async () => [],
    listProjects: async () => [{ id: "project-1", agentIds: ["logical-agent-1"] }],
  };

  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("我的项目"));
  expect(screen.getByRole("button", { name: /展开关联 Agent/ })).toBeVisible();

  await user.click(screen.getByRole("button", { name: /展开关联 Agent/ }));
  expect(screen.getByLabelText("Codex CLI")).toBeChecked();

  await user.click(screen.getByRole("button", { name: "预览" }));
  await waitFor(() => expect(preview).toHaveBeenNthCalledWith(1,
    [expect.objectContaining({ skillId: "skill-pdf", targetIds: expect.arrayContaining(["project-1", "logical-agent-1"]) })],
    undefined,
  ));
});

it("states that batch commits are not atomic", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture().slice(0, 1),
    preview: async () => previewBatch([]),
    commit: async () => [],
  };
  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} /></MemoryRouter></I18nextProvider>);

  expect(await screen.findByText(/不是原子操作/)).toBeVisible();
});

it("aggregates mixed pair outcomes into succeeded, skipped and failed groups", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const statuses = ["succeeded", "skipped", "failed"] as const;
  let index = 0;
  const pairs = Array.from({ length: 3 }, (_, pairIndex) => pair({
    pairId: `s${pairIndex + 1}:t1`,
    skillId: `skill-${pairIndex + 1}`,
    skillDisplayName: `Skill ${pairIndex + 1}`,
    disposition: "selected_mode",
    mode: "managed_copy",
  }));
  const facade: BatchDeploymentFacade = {
    listTargets: async () => deploymentTargetsFixture().slice(0, 1),
    preview: async () => previewBatch(pairs),
    commit: vi.fn<BatchDeploymentFacade["commit"]>(async (previewArg, selections) => selections.map((selection) => {
      const facts = previewArg.pairs.find((candidate) => candidate.pairId === selection.pairId);
      return {
        skillId: facts?.skillId ?? "",
        targetId: facts?.logicalTargetIds[0] ?? "",
        label: facts?.targetLabel ?? "",
        status: statuses[index++ % statuses.length],
        message: "结果说明",
      };
    })),
  };

  render(<I18nextProvider i18n={i18n}><MemoryRouter><BatchDeploymentPage facade={facade} skillIds={["skill-a", "skill-b", "skill-c"]} /></MemoryRouter></I18nextProvider>);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));

  const summary = await screen.findByTestId("batch-summary");
  expect(summary).toHaveTextContent("成功 1");
  expect(summary).toHaveTextContent("跳过 1");
  expect(summary).toHaveTextContent("失败 1");
  expect(screen.getAllByTestId("batch-outcome-failed")).toHaveLength(1);
});

it("preselects the target passed via the target search parameter", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const targets = deploymentTargetsFixture().slice(0, 2);
  const preview = vi.fn<BatchDeploymentFacade["preview"]>(async () => previewBatch([]));
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

  await userEvent.setup().click(screen.getByRole("button", { name: "预览" }));
  await waitFor(() => expect(preview).toHaveBeenCalledWith([expect.objectContaining({ targetIds: [targets[1].id] })], undefined));
});

it("exposes the batch step rail and keeps the non-atomic risk adjacent to the commit", async () => {
  const user = userEvent.setup();
  const facade = batchFacade(() => previewBatch(allCopyPairs(["codex-cli"])));
  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);

  const rail = screen.getByRole("list", { name: "添加步骤" });
  const steps = within(rail).getAllByRole("listitem");
  expect(steps).toHaveLength(4);
  expect(steps[0]).toHaveAttribute("aria-current", "step");
  expect(steps[3]).toHaveTextContent("结果");

  await screen.findByLabelText("Codex CLI");
  // 非原子风险在选择阶段就可见，并且随流程进入 footer 操作区。
  const risk = screen.getByText(/不是原子操作/);
  expect(risk.closest("footer")).not.toBeNull();

  const previewButton = screen.getByRole("button", { name: "预览" });
  const footerBefore = previewButton.closest("footer");
  expect(footerBefore).not.toBeNull();

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(previewButton);

  const commit = await screen.findByRole("button", { name: "确认添加" });
  expect(commit.closest("footer")).toBe(footerBefore);
  // 提交动作与非原子风险提示必须相邻（同一个 footer 操作区内）。
  expect(within(commit.closest("footer") as HTMLElement).getByText(/不是原子操作/)).toBeVisible();
  expect(within(screen.getByRole("list", { name: "添加步骤" })).getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "step");

  await user.click(commit);
  expect(await screen.findByTestId("batch-summary")).toHaveTextContent("成功 2");
  expect(facade.commit).toHaveBeenCalledTimes(1);
});

it("moves focus to the preview heading after a (re-)preview (14.16)", async () => {
  const user = userEvent.setup();
  await renderBatchPage(batchFacade(() => previewBatch(allCopyPairs(["codex-cli"]))), ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 重新预览后焦点落在新呈现的预览区标题上，不丢失也不落在过期内容。
  await screen.findByRole("button", { name: "确认添加" });
  expect(screen.getByRole("heading", { name: /添加计划/ })).toHaveFocus();
});

it("maps the skill UUID to a display name and never renders the raw id (DEV-18-A + DEV-99)", async () => {
  const user = userEvent.setup();
  const facade = batchFacade(() => previewBatch([pair({ pairId: "sku-0001-aaaa:t1", skillId: "sku-0001-aaaa", skillDisplayName: "PDF 抽取器" })]));

  await renderBatchPage(facade, ["sku-0001-aaaa"]);
  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  expect(within(plan).getByText("PDF 抽取器")).toBeVisible();
  // DEV-99：内部 id 全面退出界面——技术详情折叠区也不展示。
  expect(within(plan).queryByText("sku-0001-aaaa")).toBeNull();
  expect(within(plan).queryByText("Skill ID")).toBeNull();
});

it("renders every blocked reason in user-facing words and keeps raw causes in technical details (14.4)", async () => {
  const user = userEvent.setup();
  const pairs = [
    pair({ pairId: "s1:t1", skillDisplayName: "Skill 1", disposition: "blocked", mode: null, blockReason: "link_permission_unavailable", technicalError: { code: "deployment.symlink_not_supported", severity: "error", params: { path: "C:/t" }, actions: [] } }),
    pair({ pairId: "s2:t1", skillDisplayName: "Skill 2", disposition: "blocked", mode: null, blockReason: "link_filesystem_unsupported" }),
    pair({ pairId: "s3:t1", skillDisplayName: "Skill 3", disposition: "blocked", mode: null, blockReason: "target_occupied" }),
    pair({ pairId: "s4:t1", skillDisplayName: "Skill 4", disposition: "blocked", mode: null, blockReason: "path_unavailable" }),
    pair({ pairId: "s5:t1", skillDisplayName: "Skill 5", disposition: "blocked", mode: null, blockReason: "shared_impact_requires_resolution" }),
  ];
  const facade = batchFacade(() => previewBatch(pairs));

  await renderBatchPage(facade, ["skill-pdf", "skill-docx"]);
  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  const plan = await screen.findByRole("region", { name: /添加计划/ });
  expect(within(plan).getByText(/当前账户无权创建链接部署/)).toBeVisible();
  expect(within(plan).getByText(/此文件的磁盘或分区不支持链接部署/)).toBeVisible();
  expect(within(plan).getByText(/目标目录已存在同名内容/)).toBeVisible();
  expect(within(plan).getByText(/目标目录当前无法访问/)).toBeVisible();
  expect(within(plan).getByText(/其他 Agent 也在读取这个共享目录/)).toBeVisible();
  // DEV-99：原始 code 不进界面（含技术详情折叠区）。
  expect(within(plan).queryByText("deployment.symlink_not_supported")).toBeNull();
});

it("swaps the target list for the plan panel at the preview step and supports going back", async () => {
  // DEV-17：计划区必须是独立呈现单元——预览步不再把「添加计划」追加在
  // 目标长列表尾部；提供「上一步」返回选择，勾选状态保持。
  const user = userEvent.setup();
  await renderBatchPage(batchFacade(() => previewBatch(allCopyPairs(["codex-cli"]))), ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 预览步：目标选择列表退出首屏，仅呈现计划区。
  expect(screen.queryByRole("region", { name: "Agent 目标" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: /添加计划/ })).toBeVisible();
  expect(screen.queryByRole("checkbox", { name: "Codex CLI" })).not.toBeInTheDocument();

  // 上一步：回到选择步，勾选保持。
  await user.click(screen.getByRole("button", { name: "上一步" }));
  const codex = await screen.findByRole("checkbox", { name: "Codex CLI" });
  expect(codex).toBeChecked();
});

it("hides the batch footer during committing and announces the non-atomic progress", async () => {
  const user = userEvent.setup();
  let resolveCommit: (value: Awaited<ReturnType<BatchDeploymentFacade["commit"]>>) => void = () => undefined;
  const facade = batchFacade(() => previewBatch(allCopyPairs(["codex-cli"], 1)), {
    commit: vi.fn<BatchDeploymentFacade["commit"]>((_preview, _selections, onProgress) => new Promise((resolve) => {
      resolveCommit = (value) => {
        onProgress?.(1);
        resolve(value);
      };
    })),
  });
  await renderBatchPage(facade, ["skill-pdf"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));

  expect(screen.queryByRole("button", { name: "确认添加" })).not.toBeInTheDocument();
  expect(await screen.findByText(/正在添加，请稍候；批次非原子/)).toBeVisible();

  resolveCommit([{ skillId: "skill-pdf", targetId: "codex-cli", label: "Codex CLI", status: "succeeded" as const, message: "已部署" }]);
  expect(await screen.findByTestId("batch-summary")).toHaveTextContent("成功 1");
});

it("shows the user-facing mode and keeps the implementation type in technical details (DEV-21-A)", async () => {
  const user = userEvent.setup();
  await renderBatchPage(batchFacade(() => previewBatch(allCopyPairs(["codex-cli"]))), ["skill-pdf", "skill-docx"]);

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));

  // 首屏主文案是「复制部署」，绝不作为主文案出现「托管复制」。
  const rows = await screen.findAllByTestId("target-plan");
  expect(rows.length).toBeGreaterThan(0);
  expect(within(rows[0]).getByText("复制部署")).toBeVisible();
  // 具体实现方式只在「技术详情」可展开区域内。
  const implNode = within(rows[0]).getByText("托管复制");
  expect(implNode.closest("details")).not.toBeNull();
  expect(implNode).not.toBeVisible();
});

it("offers a reachable manage-deployment entry after a successful batch (DEV-21-A)", async () => {
  const user = userEvent.setup();
  const onManageDeployment = vi.fn();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <BatchDeploymentPage facade={batchFacade(() => previewBatch(allCopyPairs(["codex-cli"])))} skillIds={["skill-pdf", "skill-docx"]} onManageDeployment={onManageDeployment} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  await user.click(await screen.findByLabelText("Codex CLI"));
  await user.click(screen.getByRole("button", { name: "预览" }));
  await user.click(await screen.findByRole("button", { name: "确认添加" }));

  // 每个成功的 Skill 一条入口（同一 Skill 的多目标不重复）。
  const manage = await screen.findAllByRole("button", { name: /管理此部署/ });
  expect(manage).toHaveLength(2);
  await user.click(screen.getAllByRole("button", { name: /管理此部署：Skill / })[0]);
  expect(onManageDeployment).toHaveBeenCalledWith("skill-1");
});

it("preselects the first available target of an agent passed via the agent search parameter", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  // 自带 agentClientId 的目标：治理清理结果只知道 Agent 身份，不知道目标 id。
  const targets: DeploymentTarget[] = [
    { ...deploymentTargetsFixture()[0], agentClientId: "codex" },
    { ...deploymentTargetsFixture()[1], agentClientId: "claude-code" },
  ];
  const facade: BatchDeploymentFacade = {
    listTargets: async () => targets,
    preview: async () => previewBatch([]),
    commit: async () => [],
  };

  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[{ pathname: "/deploy", search: "?skill=skill-pdf&agent=codex" }]}>
        <BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  // 治理清理结果只知道 Agent 身份：按 agentClientId 解析首个可用目标。
  // 目标卡的可达名即 agentClientId（与展示层的品牌/类型徽标无关）。
  await waitFor(() => expect(screen.getByLabelText("codex")).toBeChecked());
  expect(screen.getByLabelText("claude-code")).not.toBeChecked();
});

describe("BatchDeploymentPage 与统一执行桥", () => {
  it("reports the batch commit to the unified tracker with pair progress and a partial finish", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    let resolveCommit!: (value: BatchDeploymentResult[]) => void;
    const facade = batchFacade(() => previewBatch(allCopyPairs(["codex-cli"])), {
      commit: vi.fn<BatchDeploymentFacade["commit"]>((_preview, _selections, onProgress) => new Promise((resolve) => {
        resolveCommit = (value) => {
          onProgress?.(2);
          resolve(value);
        };
      })),
    });
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/deploy"]}>
          <BatchDeploymentPage facade={facade} skillIds={["skill-pdf", "skill-docx"]} tracker={tracker} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));

    // 批次在途：一个批次任务，进度分母是可执行 pair 数。
    const [inFlight] = tracker.getSnapshot();
    expect(inFlight.status).toBe("running");
    expect(inFlight.kind).toBe("deploy");
    expect(inFlight.label).toBe("添加到 Agent/项目");
    expect(inFlight.total).toBe(2);

    resolveCommit([
      { skillId: "skill-1", targetId: "codex-cli", label: "Codex CLI", status: "succeeded", message: "deployment.results.status.message.succeeded", operationId: "op-batch-1" },
      { skillId: "skill-2", targetId: "codex-cli", label: "Codex CLI", status: "failed", message: "目标目录不可写", operationId: "op-batch-2" },
    ]);
    expect(await screen.findByTestId("batch-summary")).toBeVisible();

    const [finished] = tracker.getSnapshot();
    expect(finished.status).toBe("partial");
    expect(finished.completed).toBe(2);
    // 多 id 批次不得伪关联到 Skill #1 的单条记录（镜像 removal 批量的既有
    // 决定）：无单 id correlate，深链退化为不带 action 的批量结果反馈。
    expect(finished.operationId).toBeNull();
    expect(finished.targetHref).toBeNull();
  });

  it("keeps the single-id correlation when a one-pair batch yields exactly one operation record", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const facade = batchFacade(() => previewBatch(allCopyPairs(["codex-cli"], 1)), {
      commit: vi.fn<BatchDeploymentFacade["commit"]>(async () => [
        { skillId: "skill-1", targetId: "codex-cli", label: "Codex CLI", status: "succeeded", message: "deployment.results.status.message.succeeded", operationId: "op-single-1" },
      ]),
    });
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/deploy"]}>
          <BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} tracker={tracker} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));
    expect(await screen.findByTestId("batch-summary")).toBeVisible();

    // 单 pair 批次只有一个持久化记录：现有 correlate 行为保持。
    const [finished] = tracker.getSnapshot();
    expect(finished.operationId).toBe("op-single-1");
    expect(finished.targetHref).toBe("/operations/op-single-1");
  });

  it("records a rejected batch on the tracker as failed and keeps the page alert", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const facade = batchFacade(() => previewBatch(allCopyPairs(["codex-cli"], 1)), {
      commit: vi.fn<BatchDeploymentFacade["commit"]>(async () => {
        throw new Error("deployment.plan_stale");
      }),
    });
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/deploy"]}>
          <BatchDeploymentPage facade={facade} skillIds={["skill-pdf"]} tracker={tracker} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await user.click(await screen.findByLabelText("Codex CLI"));
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(await screen.findByRole("button", { name: "确认添加" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    const [failed] = tracker.getSnapshot();
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("deployment.plan_stale");
  });
});
