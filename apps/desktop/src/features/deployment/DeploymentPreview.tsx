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
  return skillId.replace(/^preview-skill-/, "Preview Skill ");
}

let previewPairSeq = 0;

function previewPair(skillId: string, target: DeploymentTarget, overrides: Partial<DeploymentPairPreview> = {}): DeploymentPairPreview {
  previewPairSeq += 1;
  return {
    pairId: `${skillId}:${target.physicalId}`,
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
    confirmationFingerprint: `preview-fp-${previewPairSeq}`,
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
  | "batch"
  | "batch-bulk"
  | "batch-preview-fail"
  | "batch-partial";

const scenarios: readonly PreviewScenario[] = [
  "default",
  "warning",
  "partial",
  "fail-preview",
  "unavailable",
  "empty",
  "batch",
  "batch-bulk",
  "batch-preview-fail",
  "batch-partial",
];

const BATCH_SCENARIOS: readonly PreviewScenario[] = ["batch", "batch-bulk", "batch-preview-fail", "batch-partial"];

function isBatchScenario(scenario: PreviewScenario): boolean {
  return BATCH_SCENARIOS.includes(scenario);
}

function previewScenario(): PreviewScenario {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return scenarios.find((candidate) => candidate === value) ?? "default";
}

function batchSkillCount(scenario: PreviewScenario): number {
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
      if (scenario === "partial" || scenario === "batch-partial") {
        return { ...pair, disposition: "blocked" as const, mode: null, blockReason: "path_unavailable" as const };
      }
      return pair;
    }));
}

function createBatchFacade(scenario: PreviewScenario): BatchDeploymentFacade {
  return {
    listTargets: async () => previewTargets(3, scenario === "batch-bulk"),
    preview: async (items) => {
      if (scenario === "fail-preview" || scenario === "batch-preview-fail") {
        throw new Error("deployment.target_not_writable");
      }
      return previewBatchOf(pairsFor(items, await previewTargets(3, scenario === "batch-bulk"), scenario));
    },
    commit: async (preview, selections): Promise<BatchDeploymentResult[]> => selections
      .filter((selection) => !selection.exclude)
      .map((selection) => {
        const facts = preview.pairs.find((candidate) => candidate.pairId === selection.pairId);
        return {
          skillId: facts?.skillId ?? "",
          displayName: facts?.skillDisplayName,
          targetId: facts?.logicalTargetIds[0] ?? "",
          label: facts?.targetLabel ?? "",
          status: "succeeded" as const,
          message: "deployment.results.status.message.succeeded",
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
