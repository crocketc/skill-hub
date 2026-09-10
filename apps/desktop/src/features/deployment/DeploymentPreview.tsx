import { useMemo } from "react";
import { BatchDeploymentPage } from "./BatchDeploymentPage";
import { DeploymentDialog } from "./DeploymentDialog";
import type {
  BatchDeploymentFacade,
  DeploymentFacade,
  DeploymentPlan,
  DeploymentResult,
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

function planFor(selected: DeploymentTarget[], warnings: string[], targetWarnings: boolean): DeploymentPlan {
  return {
    skillId: "preview-skill",
    versionId: "v1",
    warnings,
    targets: selected.map((target) => ({
      targetId: target.id,
      label: target.label,
      mode: "symbolic_link",
      warnings: targetWarnings ? ["Target directory already contains a Skill with the same runtime name."] : [],
    })),
  };
}

function resultFor(plans: DeploymentPlan[], failedIds: string[] = []): DeploymentResult[] {
  return plans.flatMap((plan) => plan.targets.map((target) => ({
    targetId: target.targetId,
    label: target.label,
    status: failedIds.includes(target.targetId) ? ("failed" as const) : ("succeeded" as const),
    message: failedIds.includes(target.targetId)
      ? "deployment.target_not_writable"
      : "deployment.results.message.succeeded",
  })));
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

function createSingleFacade(scenario: PreviewScenario): DeploymentFacade {
  if (scenario === "unavailable") {
    return {
      listTargets: () => Promise.reject(new Error("preview.deploy_targets_unavailable")),
      preview: () => Promise.reject(new Error("preview.unavailable")),
      commit: () => Promise.reject(new Error("preview.unavailable")),
    };
  }
  return {
    listTargets: async () => previewTargets(3, scenario === "batch-bulk"),
    preview: async (selected) => {
      if (scenario === "fail-preview") throw new Error("deployment.target_not_writable");
      return planFor(
        selected,
        scenario === "warning" ? ["The target directory is a junction; the Skill will deploy through it."] : [],
        scenario === "warning",
      );
    },
    commit: async (plan) => resultFor([plan], scenario === "partial" ? ["target-1"] : []),
  };
}

function createBatchFacade(scenario: PreviewScenario): BatchDeploymentFacade {
  const skillIds = Array.from({ length: batchSkillCount(scenario) }, (_, index) => `preview-skill-${index + 1}`);
  return {
    listTargets: async () => previewTargets(3, scenario === "batch-bulk"),
    preview: async (_skillIds, selected) => scenario === "batch-preview-fail"
      ? {
          failures: [{ skillId: "preview-skill-2", message: "preview.version_missing" }],
          plans: [{
            skillId: "preview-skill-1",
            plan: planFor(selected, [], false),
          }],
        }
      : {
          failures: [],
          plans: skillIds.map((skillId) => ({ skillId, plan: planFor(selected, [], false) })),
        },
    commit: async (plans) => plans.flatMap(({ skillId, plan }) => resultFor(
      [plan],
      scenario === "batch-partial" ? [plan.targets[0]?.targetId ?? ""] : [],
    ).map((result) => ({ ...result, skillId }))),
  };
}

/**
 * DEV-only preview for the deployment flows (T4-D). `?scenario=` selects
 * deterministic layouts: plan warnings, partial failure, preview failure,
 * target discovery failure, and the batch route with 8 or 60+ Skills and
 * long paths. Everything runs on mock facades without native or network
 * calls.
 */
export function DeploymentPreview() {
  const scenario = useMemo(previewScenario, []);

  if (isBatchScenario(scenario)) {
    const skillIds = Array.from({ length: batchSkillCount(scenario) }, (_, index) => `preview-skill-${index + 1}`);
    return <BatchDeploymentPage facade={createBatchFacade(scenario)} skillIds={skillIds} />;
  }

  return <DeploymentDialog facade={createSingleFacade(scenario)} skillId="preview-skill" versionId="v1" />;
}
