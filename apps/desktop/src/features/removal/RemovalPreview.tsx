import { useMemo } from "react";
import { BatchRemovalImpactDialog } from "./BatchRemovalImpactDialog";
import { RemovalImpactDialog } from "./RemovalImpactDialog";
import { UndeployDialog } from "./UndeployDialog";
import { removalImpactFixture, type RemovalImpact } from "./api";

type PreviewScenario =
  | "impact"
  | "impact-error"
  | "batch"
  | "batch-busy"
  | "batch-bulk"
  | "undeploy"
  | "undeploy-shared";

const scenarios: readonly PreviewScenario[] = [
  "impact",
  "impact-error",
  "batch",
  "batch-busy",
  "batch-bulk",
  "undeploy",
  "undeploy-shared",
];

function previewScenario(): PreviewScenario {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return scenarios.find((candidate) => candidate === value) ?? "impact";
}

function batchImpacts(count: number, withMatrix: boolean): RemovalImpact[] {
  return Array.from({ length: count }, (_, index) => ({
    operationId: `delete-preview-${index + 1}`,
    skillId: `preview-skill-${index + 1}`,
    skillName: `Preview Skill ${index + 1}`,
    deployments: index === 0
      ? [{ id: "codex", label: "Codex CLI", path: "C:/Users/demo/.codex/skills", physicalId: "codex-skills" }]
      : [],
    dependentProjects: withMatrix && index === 0 ? ["Aurora", "Very Long Preview Project Name For Layout Checks"] : [],
    declaredDependencies: withMatrix && index === 0 ? ["python 3.11 runtime"] : [],
    pinnedVersions: withMatrix && index === 0 ? [{ projectId: "project-aurora", versionId: "sha256:preview" }] : [],
    combinations: withMatrix && index === 0 ? ["Cleanup combo"] : [],
    relatedSkills: withMatrix && index === 0 ? ["Notes packager"] : [],
    unknownExternalReferences: withMatrix && index === 0 ? ["/agents/root/very/long/external/reference/path"] : [],
  }));
}

/**
 * DEV-only preview for the removal confirmations (T4-D). `?scenario=`
 * selects the single impact matrix, its error state, the batch matrix
 * (normal, busy, bulk) and both undeploy variants. Deterministic props
 * only; the hosts (skill detail / library) are exercised by their own
 * previews.
 */
export function RemovalPreview() {
  const scenario = useMemo(previewScenario, []);
  const noop = () => undefined;

  if (scenario.startsWith("undeploy")) {
    return (
      <UndeployDialog
        impact={{ deploymentId: "dep-1", label: "Codex CLI", operationId: "op-undeploy-1", sharedTarget: scenario === "undeploy-shared" }}
        onCancel={noop}
        onConfirm={noop}
      />
    );
  }

  if (scenario.startsWith("batch")) {
    return (
      <BatchRemovalImpactDialog
        impacts={batchImpacts(scenario === "batch-bulk" ? 12 : 2, scenario !== "batch-busy")}
        onCancel={noop}
        onConfirm={noop}
        submitting={scenario === "batch-busy"}
      />
    );
  }

  return (
    <RemovalImpactDialog
      error={scenario === "impact-error" ? "removal.commitError" : undefined}
      impact={removalImpactFixture()}
      onCancel={noop}
      onConfirm={noop}
    />
  );
}
