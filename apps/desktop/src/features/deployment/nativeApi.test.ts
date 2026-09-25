import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { createNativeBatchDeploymentFacade } from "./nativeApi";
import type { BatchPreviewItem, DeploymentPreviewBatch } from "./api";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => {
  vi.mocked(queryApplication).mockReset();
  vi.mocked(executeCommand).mockReset();
});

const items: BatchPreviewItem[] = [{ skillId: "skill-pdf", targetIds: ["codex-global"], preference: "link" }];

const nativePairs = [{
  pair_id: "skill-pdf:fs-codex",
  skill_id: "skill-pdf",
  skill_display_name: "PDF 抽取器",
  version_id: "v1",
  runtime_name: "pdf",
  logical_target_ids: ["codex-global"],
  target_label: "Codex CLI",
  target_path: "C:/Users/demo/.codex/skills",
  destination_path: "C:/Users/demo/.codex/skills/pdf",
  preference: "link",
  disposition: "recommend_copy",
  mode: null,
  fallback_mode: "managed_copy",
  block_reason: "link_permission_unavailable",
  warnings: [],
  confirmation_preserved: false,
  confirmation_fingerprint: "fp-1",
  technical_error: null,
}];

const previewBatch: DeploymentPreviewBatch = {
  previewId: "preview-1",
  expiresAt: "2026-09-24T01:00:00Z",
  pairs: [{
    pairId: "skill-pdf:fs-codex",
    skillId: "skill-pdf",
    skillDisplayName: "PDF 抽取器",
    runtimeName: "pdf",
    logicalTargetIds: ["codex-global"],
    targetLabel: "Codex CLI",
    targetPath: "C:/Users/demo/.codex/skills",
    destinationPath: "C:/Users/demo/.codex/skills/pdf",
    preference: "link",
    disposition: "recommend_copy",
    mode: null,
    fallbackMode: "managed_copy",
    blockReason: "link_permission_unavailable",
    warnings: [],
    confirmationPreserved: false,
    confirmationFingerprint: "fp-1",
    technicalError: null,
  }],
  preservedConfirmationIds: [],
};

function mockPreviewResponse(pairs: unknown[] = nativePairs, preserved: string[] = []) {
  vi.mocked(queryApplication).mockResolvedValue({
    type: "deployment_batch_preview",
    payload: {
      preview_id: "preview-1",
      expires_at: "2026-09-24T01:00:00Z",
      pairs,
      preserved_confirmation_ids: preserved,
    },
  } as never);
}

it("lists only registered deployment targets and preserves capability modes", async () => {
  vi.mocked(queryApplication).mockResolvedValue({
    type: "deployment_targets",
    payload: [{
      id: "codex-global",
      label: "Codex CLI",
      path: "C:/Users/demo/.codex/skills",
      available: true,
      physical_id: "fs:codex",
      modes: ["managed_copy"],
    }],
  });

  await expect(createNativeBatchDeploymentFacade().listTargets()).resolves.toEqual([{
    id: "codex-global",
    label: "Codex CLI",
    path: "C:/Users/demo/.codex/skills",
    available: true,
    physicalId: "fs:codex",
    modes: ["managed_copy"],
  }]);
  expect(queryApplication).toHaveBeenCalledWith({ type: "list_deployment_targets", payload: null });
});

it("previews the whole batch in one native call and maps pair facts", async () => {
  mockPreviewResponse();

  const preview = await createNativeBatchDeploymentFacade().preview(items);
  expect(queryApplication).toHaveBeenCalledTimes(1);
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_deployment_batch_preview",
    payload: {
      items: [{
        skill_id: "skill-pdf",
        version_id: null,
        runtime_name: null,
        logical_target_ids: ["codex-global"],
        preference: "link",
      }],
      confirmations: {},
      exclusions: [],
    },
  });
  expect(preview.previewId).toBe("preview-1");
  expect(preview.pairs).toEqual([previewBatch.pairs[0]]);
});

it("sends held confirmation fingerprints and exclusions on a re-preview", async () => {
  mockPreviewResponse(nativePairs, ["skill-pdf:fs-codex"]);

  const preview = await createNativeBatchDeploymentFacade().preview(items, {
    confirmations: { "skill-pdf:fs-codex": "fp-1" },
    exclusions: ["skill-pdf:fs-other"],
  });
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_deployment_batch_preview",
    payload: {
      items: [{
        skill_id: "skill-pdf",
        version_id: null,
        runtime_name: null,
        logical_target_ids: ["codex-global"],
        preference: "link",
      }],
      confirmations: { "skill-pdf:fs-codex": "fp-1" },
      exclusions: ["skill-pdf:fs-other"],
    },
  });
  expect(preview.preservedConfirmationIds).toEqual(["skill-pdf:fs-codex"]);
});

it("commits only the preview id and per-pair selections, then joins Skill facts into results", async () => {
  vi.mocked(executeCommand).mockResolvedValue({
    type: "deployment_preview_commit_result",
    payload: {
      preview_id: "preview-1",
      replayed: false,
      pairs: [
        { pair_id: "skill-pdf:fs-codex", outcome: "deployed", operation_id: "op-1", error: null },
      ],
    },
  });

  const results = await createNativeBatchDeploymentFacade().commit(
    previewBatch,
    [{ pairId: "skill-pdf:fs-codex", confirmFallback: true, exclude: false }],
  );
  expect(executeCommand).toHaveBeenCalledWith({
    type: "commit_deployment_preview",
    payload: {
      preview_id: "preview-1",
      pairs: [{ pair_id: "skill-pdf:fs-codex", confirm_fallback: true, exclude: false }],
    },
  });
  // 路由/汇总沿用的三态投影 + Skill 展示名由预览 facts 联接而来（DEV-18-A）。
  expect(results).toEqual([expect.objectContaining({
    skillId: "skill-pdf",
    displayName: "PDF 抽取器",
    targetId: "codex-global",
    label: "Codex CLI",
    status: "succeeded",
    operationId: "op-1",
  })]);
});

it("projects every pair outcome, including excluded and blocked, without hiding any", async () => {
  const allPairs = [
    ...nativePairs,
    {
      ...nativePairs[0],
      pair_id: "skill-pdf:fs-claude",
      target_label: "Claude Code",
      logical_target_ids: ["claude-global"],
      disposition: "selected_mode",
      block_reason: null,
      mode: "managed_copy",
      fallback_mode: null,
    },
    {
      ...nativePairs[0],
      pair_id: "skill-pdf:fs-win",
      target_label: "Win Cli",
      logical_target_ids: ["win-global"],
      disposition: "blocked",
      block_reason: "target_occupied",
      fallback_mode: null,
    },
  ];
  mockPreviewResponse(allPairs);
  const preview = await createNativeBatchDeploymentFacade().preview(items);
  vi.mocked(executeCommand).mockResolvedValue({
    type: "deployment_preview_commit_result",
    payload: {
      preview_id: "preview-1",
      replayed: false,
      pairs: [
        { pair_id: "skill-pdf:fs-codex", outcome: "deployed", operation_id: null, error: null },
        { pair_id: "skill-pdf:fs-claude", outcome: "excluded", operation_id: null, error: null },
        { pair_id: "skill-pdf:fs-win", outcome: "blocked", operation_id: null, error: null },
      ],
    },
  });

  const results = await createNativeBatchDeploymentFacade().commit(preview, [
    { pairId: "skill-pdf:fs-codex", confirmFallback: false, exclude: false },
    { pairId: "skill-pdf:fs-claude", confirmFallback: false, exclude: true },
    { pairId: "skill-pdf:fs-win", confirmFallback: false, exclude: false },
  ]);
  expect(results).toEqual([
    expect.objectContaining({ status: "succeeded" }),
    expect.objectContaining({ status: "skipped" }),
    expect.objectContaining({ status: "failed" }),
  ]);
});

it("keeps the structured technical error on a failed pair result", async () => {
  const structured = {
    code: "deployment.target_exists",
    severity: "error",
    params: { path: "C:/Users/demo/.claude/skills/find-skills" },
    actions: ["choose_another_name", "inspect_target"],
  };
  vi.mocked(executeCommand).mockResolvedValue({
    type: "deployment_preview_commit_result",
    payload: {
      preview_id: "preview-1",
      replayed: false,
      pairs: [{
        pair_id: "skill-pdf:fs-codex",
        outcome: "failed",
        operation_id: null,
        error: structured,
      }],
    },
  } as never);

  const results = await createNativeBatchDeploymentFacade().commit(
    previewBatch,
    [{ pairId: "skill-pdf:fs-codex", confirmFallback: false, exclude: false }],
  );
  expect(results[0].status).toBe("failed");
  expect(results[0].error).toEqual(structured);
  expect(results[0].message).not.toContain("[object Object]");
});

it("reports progress with the executable pair count as the denominator (14.9)", async () => {
  vi.mocked(executeCommand).mockResolvedValue({
    type: "deployment_preview_commit_result",
    payload: {
      preview_id: "preview-1",
      replayed: false,
      pairs: [
        { pair_id: "skill-pdf:fs-codex", outcome: "deployed", operation_id: null, error: null },
      ],
    },
  });
  const onProgress = vi.fn();

  await createNativeBatchDeploymentFacade().commit(
    previewBatch,
    [{ pairId: "skill-pdf:fs-codex", confirmFallback: false, exclude: false }],
    onProgress,
  );
  expect(onProgress).toHaveBeenCalledWith(1);
});

it("surfaces unexpected native results as stable codes, not localized sentences", async () => {
  vi.mocked(queryApplication).mockResolvedValue({ type: "bootstrap_snapshot", payload: {} } as never);
  const error = await createNativeBatchDeploymentFacade().listTargets().then(
    () => null,
    (reason: Error) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toBe("deployment.targets_unexpected_result");
  expect(error?.message).not.toMatch(/[一-龥]/);
});
