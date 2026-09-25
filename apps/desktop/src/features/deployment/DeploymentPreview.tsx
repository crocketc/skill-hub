import { useMemo } from "react";
import { BatchDeploymentPage } from "./BatchDeploymentPage";
import { DeploymentDialog } from "./DeploymentDialog";
import type {
  BatchDeploymentFacade,
  BatchDeploymentResult,
  BatchPreviewItem,
  DeploymentPairPreview,
  DeploymentPreviewBatch,
  DeploymentTarget,
} from "./api";

const LONG_PATH = "C:/Users/demo/very-long-preview-directory-segment/agent-skills";

function previewTargets(targetCount = 3, longPaths = false): DeploymentTarget[] {
  const path = longPaths ? `${LONG_PATH}/with/an/extremely/long/suffix` : "C:/Users/demo/.codex/skills";
  return Array.from({ length: targetCount }, (_, index) => ({
    id: `target-${index + 1}`,
    label: index === 2 ? "Unavailable target" : `Preview Agent ${index + 1}`,
    path: longPaths ? `${path}/preview-skill-${index + 1}` : path,
    available: index !== 2,
    physicalId: `physical-${index + 1}`,
    modes: index % 2 === 0 ? ["symbolic_link", "managed_copy"] : ["managed_copy"],
  }));
}

function previewSkillDisplayName(skillId: string): string {
  const match = skillId.match(/^preview-skill(?:-(\d+))?$/);
  return match ? `Preview Skill${match[1] ? ` ${match[1]}` : ""}` : skillId;
}

function previewPair(skillId: string, target: DeploymentTarget, overrides: Partial<DeploymentPairPreview> = {}): DeploymentPairPreview {
  const pairId = `${skillId}:${target.physicalId}`;
  return {
    pairId,
    skillId,
    skillDisplayName: previewSkillDisplayName(skillId),
    logicalTargetIds: [target.id],
    runtimeName: "preview-skill",
    targetLabel: target.label,
    targetPath: target.path,
    destinationPath: `${target.path}/preview-skill`,
    preference: "automatic",
    disposition: "selected_mode",
    mode: "managed_copy",
    fallbackMode: null,
    blockReason: null,
    warnings: [],
    confirmationPreserved: false,
    // 指纹按 pairId 确定性派生：重新预览携带同指纹时后端语义（保留确认）
    // 才能在 mock 上复现（14.7）。
    confirmationFingerprint: `preview-fp-${pairId}`,
    technicalError: null,
    ...overrides,
  };
}

function previewBatchOf(pairs: DeploymentPairPreview[]): DeploymentPreviewBatch {
  return {
    previewId: `preview-${pairs.length}-${pairs[0]?.pairId ?? "empty"}`,
    expiresAt: "2026-09-24T01:00:00Z",
    pairs,
    preservedConfirmationIds: [],
  };
}

type PreviewScenario =
  | "default"
  | "warning"
  | "partial"
  | "fail-preview"
  | "unavailable"
  | "empty"
  | "fallback"
  | "batch"
  | "batch-bulk"
  | "batch-preview-fail"
  | "batch-partial"
  | "batch-fallback";

const scenarios: readonly PreviewScenario[] = [
  "default",
  "warning",
  "partial",
  "fail-preview",
  "unavailable",
  "empty",
  "fallback",
  "batch",
  "batch-bulk",
  "batch-preview-fail",
  "batch-partial",
  "batch-fallback",
];

const BATCH_SCENARIOS: readonly PreviewScenario[] = [
  "batch",
  "batch-bulk",
  "batch-preview-fail",
  "batch-partial",
  "batch-fallback",
];

function isBatchScenario(scenario: PreviewScenario): boolean {
  return BATCH_SCENARIOS.includes(scenario);
}

function previewScenario(): PreviewScenario {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return scenarios.find((candidate) => candidate === value) ?? "default";
}

function batchSkillCount(scenario: PreviewScenario): number {
  if (scenario === "batch-fallback") return 2;
  return scenario === "batch-bulk" ? 60 : 8;
}

function pairsFor(items: BatchPreviewItem[], targets: DeploymentTarget[], scenario: PreviewScenario): DeploymentPairPreview[] {
  return items.flatMap((item) => targets
    .filter((target) => item.targetIds.includes(target.id))
    .map((target) => {
      const pair = previewPair(item.skillId, target);
      if (scenario === "warning") {
        return {
          ...pair,
          warnings: ["The target directory is a junction; the Skill will deploy through it."],
        };
      }
      // 部分受阻：target-2 不可达（blocked 不拖住其余可执行项）。
      if (scenario === "partial" || scenario === "batch-partial") {
        return target.id === "target-2"
          ? { ...pair, disposition: "blocked" as const, mode: null, blockReason: "path_unavailable" as const }
          : pair;
      }
      // 回退确认：target-1 无法建链，后端建议改用复制（不静默降级，14.5）。
      if (scenario === "fallback" || scenario === "batch-fallback") {
        return target.id === "target-1"
          ? {
              ...pair,
              disposition: "recommend_copy" as const,
              mode: null,
              fallbackMode: "managed_copy" as const,
              blockReason: "link_permission_unavailable" as const,
            }
          : pair;
      }
      return pair;
    }));
}

function createBatchFacade(scenario: PreviewScenario): BatchDeploymentFacade {
  return {
    listTargets: async () => {
      if (scenario === "unavailable") {
        throw new Error("preview.deploy_targets_unavailable");
      }
      return previewTargets(3, scenario === "batch-bulk");
    },
    preview: async (items, context) => {
      if (scenario === "fail-preview" || scenario === "batch-preview-fail") {
        throw new Error("deployment.target_not_writable");
      }
      const pairs = pairsFor(items, await previewTargets(3, scenario === "batch-bulk"), scenario);
      // 镜像后端裁决（14.7）：持有指纹与当前指纹一致才保留确认。
      const held = context?.confirmations ?? {};
      const preservedIds = new Set(pairs
        .filter((pair) => held[pair.pairId] === pair.confirmationFingerprint)
        .map((pair) => pair.pairId));
      return {
        ...previewBatchOf(pairs),
        preservedConfirmationIds: [...preservedIds],
        pairs: pairs.map((pair) => ({
          ...pair,
          confirmationPreserved: preservedIds.has(pair.pairId),
        })),
      };
    },
    // 镜像生产结果投影：excluded→skipped、blocked/未确认回退→failed、
    // 其余→succeeded；结果行覆盖全部提交 selections（含排除项）。
    commit: async (preview, selections): Promise<BatchDeploymentResult[]> => selections.map((selection) => {
      const facts = preview.pairs.find((candidate) => candidate.pairId === selection.pairId);
      const blocked = facts?.disposition === "blocked"
        || (facts?.disposition === "recommend_copy" && !selection.confirmFallback);
      const status = selection.exclude
        ? "skipped" as const
        : blocked ? "failed" as const : "succeeded" as const;
      return {
        skillId: facts?.skillId ?? "",
        displayName: facts?.skillDisplayName,
        targetId: facts?.logicalTargetIds[0] ?? "",
        label: facts?.targetLabel ?? "",
        status,
        message: selection.exclude
          ? "deployment.results.status.message.skipped"
          : blocked
            ? "deployment.blockReason.committedBlocked"
            : "deployment.results.status.message.succeeded",
      };
    }),
  };
}

/**
 * DEV-only preview for the deployment flows (T4-D). `?scenario=` selects
 * deterministic layouts: pair disposition groups, partial failure, preview
 * failure, target discovery failure, and the batch route with 8 or 60+
 * Skills and long paths. Everything runs on mock facades without native or
 * network calls.
 */
export function DeploymentPreview() {
  const scenario = useMemo(previewScenario, []);

  if (isBatchScenario(scenario)) {
    const skillIds = Array.from({ length: batchSkillCount(scenario) }, (_, index) => `preview-skill-${index + 1}`);
    return <BatchDeploymentPage facade={createBatchFacade(scenario)} skillIds={skillIds} />;
  }

  return <DeploymentDialog facade={createBatchFacade(scenario)} skillId="preview-skill" versionId="current" />;
}
