import { useMemo } from "react";
import { BatchRemovalImpactDialog } from "./BatchRemovalImpactDialog";
import { useTranslation } from "react-i18next";
import { RemovalImpactDialog } from "./RemovalImpactDialog";
import { UndeployDialog } from "./UndeployDialog";
import { Icon } from "../../ui/Icon";
import { removalImpactFixture, type RemovalImpact } from "./api";

type PreviewScenario =
  | "impact"
  | "impact-error"
  | "load-failed"
  | "batch"
  | "batch-busy"
  | "batch-bulk"
  | "undeploy"
  | "undeploy-shared";

const scenarios: readonly PreviewScenario[] = [
  "impact",
  "impact-error",
  "load-failed",
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
  const { t } = useTranslation();
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

  if (scenario === "load-failed") {
    // K2/G-10：镜像 SkillDetailPage 影响查询失败的用户可见状态——
    // 错误进 alert、确认对话框（含确认入口）完全不渲染。
    return (
      <section className="sh-workflow-card">
        <p className="sh-removal-flow__error" role="alert">
          <Icon aria-hidden="true" name="failure" size={16} />
          {t("removal.errors.deploymentTargetUnavailable")}
        </p>
      </section>
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
      error={scenario === "impact-error" ? t("removal.commitError") : undefined}
      // W1-2：预览影响载荷带未完成草稿（draft_count>0），级联草稿行与确认
      // 说明在 DEV/E2E 可见；共享 fixture 保持无草稿缺省（删除断言各有归属）。
      impact={{ ...removalImpactFixture(), draftCount: 2 }}
      onCancel={noop}
      onConfirm={noop}
    />
  );
}
