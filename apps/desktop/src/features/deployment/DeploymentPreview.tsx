import { useMemo } from "react";
import { BatchDeploymentPage } from "./BatchDeploymentPage";
import { DeploymentDialog } from "./DeploymentDialog";
import type {
  BatchDeploymentFacade,
  BatchDeploymentResult,
  BatchPreviewItem,
  DeploymentPairPreview,
  DeploymentPreviewBatch,
  RecentDeploymentPreviewRequest,
  DeploymentTarget,
} from "./api";
import type { AgentCardModel } from "../agents/agentCardModel";
import type { AgentDirectoryView } from "../agents/api";

const LONG_PATH = "C:/Users/demo/very-long-preview-directory-segment/agent-skills";

function previewTargets(targetCount = 3, longPaths = false, agentCard = false): DeploymentTarget[] {
  const path = longPaths ? `${LONG_PATH}/with/an/extremely/long/suffix` : "C:/Users/demo/.codex/skills";
  return Array.from({ length: targetCount }, (_, index) => {
    const targetPath = longPaths ? `${path}/preview-skill-${index + 1}` : path;
    const target: DeploymentTarget = {
      id: `target-${index + 1}`,
      label: index === 2 ? "Unavailable target" : `Preview Agent ${index + 1}`,
      path: targetPath,
      available: index !== 2,
      writable: index !== 2,
      physicalId: `physical-${index + 1}`,
      modes: index % 2 === 0 ? ["symbolic_link", "managed_copy"] : ["managed_copy"],
    };
    if (!agentCard || index !== 0) return target;

    const directory: AgentDirectoryView = {
      path: targetPath,
      status: "existing" as const,
      role: "agent_user" as const,
      isSharedDirectory: false,
      supportsSharedDirectory: true,
      sharedReference: false,
      builtin: false,
      readable: true,
      writable: true,
      available: true,
      physicalIdentityVerified: true,
      physicalIdentityKey: "preview-openai-directory",
      supportedModes: ["symbolic_link", "managed_copy"],
      preferredMode: "symbolic_link" as const,
      deploymentStatus: "not_deployed" as const,
    };
    const cardModel: AgentCardModel = {
      id: "preview-openai-directory",
      brand: "OpenAI",
      brandLabel: "OpenAI",
      kinds: ["cli"],
      directories: [directory],
      sharedDirectory: false,
      supportsSharedDirectory: true,
      sharedAgentBrands: [],
      sharedAgentBrandKinds: {},
      builtin: false,
      readOnly: false,
      supportedModes: ["symbolic_link", "managed_copy"],
      preferredMode: "symbolic_link",
      deploymentStatus: "not_deployed",
      detailTarget: "preview-openai",
      members: [],
    };
    return {
      ...target,
      agentClientId: "openai.codex-cli",
      agentProfileId: "openai",
      cardModel,
    };
  });
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
  | "security-alert-blocked"
  | "unavailable"
  | "empty"
  | "fallback"
  | "batch"
  | "batch-bulk"
  | "batch-preview-fail"
  | "batch-partial"
  | "batch-fallback"
  | "target-eligibility"
  | "batch-target-eligibility"
  | "pending-single"
  | "pending-batch"
  | "conflict-single"
  | "conflict-batch"
  | "conflict-stale-single"
  | "conflict-stale-batch"
  | "recent-single"
  | "recent-batch"
  | "path-layout";

const scenarios: readonly PreviewScenario[] = [
  "default",
  "warning",
  "partial",
  "fail-preview",
  "security-alert-blocked",
  "unavailable",
  "empty",
  "fallback",
  "batch",
  "batch-bulk",
  "batch-preview-fail",
  "batch-partial",
  "batch-fallback",
  "target-eligibility",
  "batch-target-eligibility",
  "pending-single",
  "pending-batch",
  "conflict-single",
  "conflict-batch",
  "conflict-stale-single",
  "conflict-stale-batch",
  "recent-single",
  "recent-batch",
  "path-layout",
];

const BATCH_SCENARIOS: readonly PreviewScenario[] = [
  "batch",
  "batch-bulk",
  "batch-preview-fail",
  "batch-partial",
  "batch-fallback",
  "batch-target-eligibility",
  "pending-batch",
  "conflict-batch",
  "conflict-stale-batch",
  "recent-batch",
];

function isBatchScenario(scenario: PreviewScenario): boolean {
  return BATCH_SCENARIOS.includes(scenario);
}

function isPendingScenario(scenario: PreviewScenario): boolean {
  return scenario === "pending-single" || scenario === "pending-batch";
}

function pendingTarget(created: boolean): DeploymentTarget {
  const target = previewTargets(1)[0];
  return {
    ...target,
    available: created,
    writable: created,
    directoryStatus: created ? "existing" : "missing",
    physicalIdentityVerified: created,
  };
}

function previewScenario(): PreviewScenario {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return scenarios.find((candidate) => candidate === value) ?? "default";
}

function batchSkillCount(scenario: PreviewScenario): number {
  if (scenario === "batch-fallback") return 2;
  if (scenario === "conflict-batch") return 3;
  if (scenario === "conflict-stale-batch") return 1;
  return scenario === "batch-bulk" ? 60 : 8;
}

function previewTargetsForScenario(scenario: PreviewScenario): DeploymentTarget[] {
  const targets = previewTargets();
  if (scenario.startsWith("conflict-")) {
    return targets.map((target, index) => ({
      ...target,
      label: `Preview Agent ${index + 1}`,
      available: true,
      writable: true,
    }));
  }
  if (scenario !== "target-eligibility" && scenario !== "batch-target-eligibility") return targets;
  return [
    { ...targets[0], label: "Read-only target", writable: false },
    { ...targets[1], label: "Unsupported target", modes: [] },
    { ...targets[2], label: "Writable target", available: true, writable: true, modes: ["managed_copy"] },
  ];
}

function conflictIndex(item: BatchPreviewItem, target: DeploymentTarget, scenario: PreviewScenario): number {
  if (scenario.endsWith("single")) return Number(target.id.match(/\d+$/)?.[0] ?? 1) - 1;
  return Number(item.skillId.match(/\d+$/)?.[0] ?? 1) - 1;
}

function conflictPair(
  pair: DeploymentPairPreview,
  target: DeploymentTarget,
  index: number,
  staleRefresh: boolean,
): DeploymentPairPreview {
  const deploymentId = `existing-deployment-${index + 1}`;
  const occupantName = staleRefresh ? "Updated occupant after target drift" : `Existing Skill ${index + 1}`;
  const availableActions = staleRefresh
    ? ["skip"] as const
    : index === 0
      ? ["replace_target", "skip"] as const
      : index === 1
        ? ["rename_and_deploy", "skip"] as const
        : ["skip"] as const;
  return {
    ...pair,
    disposition: "blocked",
    mode: null,
    blockReason: "target_occupied",
    conflict: {
      occupants: [{
        ownership: "managed",
        deployment_id: deploymentId,
        skill_id: `existing-skill-${index + 1}`,
        version_id: "preview-existing-v1",
        skill_display_name: occupantName,
        physical_target_id: target.physicalId ?? target.id,
        runtime_name: pair.runtimeName,
        target_path: `${target.path}/${pair.runtimeName}`,
        consumers: [deploymentId],
        entry_identity: `preview-entry-${index + 1}`,
        content_fingerprint: `sha256:preview-entry-${index + 1}`,
      }],
      shared_target: !staleRefresh,
      shared_consumers_complete: !staleRefresh,
      shared_consumers: staleRefresh ? [] : [{
        kind: "agent",
        consumer_id: `consumer-${index + 1}`,
        display_name: `Dispatch consumer ${index + 1}`,
        logical_target_ids: [target.id],
        active_deployment_ids: [deploymentId],
      }],
      shared_consumer_fingerprint: `sha256:preview-consumer-${index + 1}`,
      available_actions: [...availableActions],
      default_action: "skip",
    },
  };
}

function pairsFor(
  items: BatchPreviewItem[],
  targets: DeploymentTarget[],
  scenario: PreviewScenario,
  previewAttempt = 1,
): DeploymentPairPreview[] {
  return items.flatMap((item) => targets
    .filter((target) => item.targetIds.includes(target.id))
    .map((target) => {
      const pair = previewPair(item.skillId, target);
      if (scenario.startsWith("conflict-")) {
        const index = conflictIndex(item, target, scenario);
        const staleRefresh = scenario.startsWith("conflict-stale-") && previewAttempt > 1;
        return conflictPair(pair, target, index, staleRefresh);
      }
      if (scenario === "warning") {
        return {
          ...pair,
          warnings: ["The target directory is a junction; dispatch will use it."],
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

/** W3-1：与原生 IPC 结构化 AppError 同形的拦截错误（nativeErrorCode 可识别）。 */
const SECURITY_ALERT_BLOCKED = {
  actions: [],
  code: "deployment.security_alert_blocked",
  params: {},
  severity: "error",
} as const;

function createBatchFacade(scenario: PreviewScenario): BatchDeploymentFacade {
  let previewAttempt = 0;
  let rejectStaleCommit = scenario.startsWith("conflict-stale-");
  let pendingDirectoryCreated = false;
  const facade: BatchDeploymentFacade = {
    listTargets: async () => {
      if (scenario === "unavailable") {
        throw new Error("preview.deploy_targets_unavailable");
      }
      if (isPendingScenario(scenario)) return [pendingTarget(pendingDirectoryCreated)];
      return scenario === "target-eligibility" || scenario === "batch-target-eligibility" || scenario.startsWith("conflict-")
        ? previewTargetsForScenario(scenario)
        : previewTargets(3, scenario === "batch-bulk" || scenario === "path-layout", scenario === "path-layout");
    },
    preview: async (items, context) => {
      if (scenario === "fail-preview" || scenario === "batch-preview-fail") {
        throw new Error("deployment.target_not_writable");
      }
      // W3-1：派发前安全预警拦截——结构化错误码经 keyedMessage 升级为
      // 可读文案，并在单技能对话框内给出安全页/待办导航。
      if (scenario === "security-alert-blocked") {
        throw SECURITY_ALERT_BLOCKED;
      }
      previewAttempt += 1;
      const pairs = pairsFor(
        items,
        scenario === "target-eligibility" || scenario === "batch-target-eligibility" || scenario.startsWith("conflict-")
          ? previewTargetsForScenario(scenario)
          : await previewTargets(3, scenario === "batch-bulk" || scenario === "path-layout", scenario === "path-layout"),
        scenario,
        previewAttempt,
      );
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
    ensureTargetDirectory: async () => {
      if (isPendingScenario(scenario)) pendingDirectoryCreated = true;
    },
    // 镜像生产结果投影：excluded→skipped、blocked/未确认回退→failed、
    // 其余→succeeded；结果行覆盖全部提交 selections（含排除项）。
    commit: async (preview, selections): Promise<BatchDeploymentResult[]> => {
      if (rejectStaleCommit) {
        rejectStaleCommit = false;
        throw {
          actions: ["retry"],
          code: "deployment.target_changed",
          params: {},
          severity: "error",
        };
      }
      return selections.map((selection) => {
        const facts = preview.pairs.find((candidate) => candidate.pairId === selection.pairId);
        const decision = selection.conflictDecision ?? (facts?.conflict
          ? { action: facts.conflict.default_action }
          : undefined);
        if (facts?.conflict) {
          if (decision?.action === "replace_target") {
            window.localStorage.setItem("skillhub.preview.replacedBackup", "1");
            return {
              skillId: facts.skillId,
              displayName: facts.skillDisplayName,
              targetId: facts.logicalTargetIds[0] ?? "",
              label: facts.targetLabel,
              status: "succeeded" as const,
              message: "deployment.results.status.message.replaced",
              conflictOutcome: "replaced" as const,
              replacedSkillDisplayName: facts.conflict.occupants[0]?.skill_display_name ?? undefined,
            };
          }
          if (decision?.action === "rename_and_deploy") {
            return {
              skillId: `derived-${facts.skillId}`,
              displayName: facts.skillDisplayName,
              targetId: facts.logicalTargetIds[0] ?? "",
              label: facts.targetLabel,
              status: "succeeded" as const,
              message: "deployment.results.status.message.renamed",
              conflictOutcome: "renamed" as const,
              runtimeName: decision.runtimeName,
            };
          }
          return {
            skillId: facts.skillId,
            displayName: facts.skillDisplayName,
            targetId: facts.logicalTargetIds[0] ?? "",
            label: facts.targetLabel,
            status: "skipped" as const,
            message: "deployment.results.status.skipped",
          };
        }
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
            ? "deployment.results.status.skipped"
            : blocked
              ? "deployment.blockReason.committedBlocked"
              : "deployment.results.status.message.succeeded",
        };
      });
    },
  };
  if (scenario === "recent-single" || scenario === "recent-batch") {
    facade.listRecentPreviewRequests = async (): Promise<RecentDeploymentPreviewRequest[]> => [{
      previewId: "preview-saved-selection",
      createdAt: "2026-10-15T03:00:00Z",
      items: scenario === "recent-single"
        ? [{ skillId: "preview-skill", versionId: "saved-v1", runtimeName: "saved-name", targetIds: ["target-1"], preference: "automatic" }]
        : [
          { skillId: "preview-skill-1", targetIds: ["target-1"], preference: "automatic" },
          { skillId: "preview-skill-2", targetIds: ["target-2"], preference: "automatic" },
        ],
    }];
  }
  return facade;
}

/**
 * DEV-only preview for the deployment flows (T4-D). `?scenario=` selects
 * deterministic layouts: pair disposition groups, partial failure, preview
 * failure, security-alert dispatch block, target discovery failure, and the
 * batch route with 8 or 60+ Skills and long paths. Everything runs on mock
 * facades without native or network calls.
 */
export function DeploymentPreview() {
  const scenario = useMemo(previewScenario, []);

  if (isBatchScenario(scenario)) {
    const skillIds = Array.from({ length: batchSkillCount(scenario) }, (_, index) => `preview-skill-${index + 1}`);
    return <BatchDeploymentPage facade={createBatchFacade(scenario)} skillIds={skillIds} />;
  }

  return <DeploymentDialog facade={createBatchFacade(scenario)} skillId="preview-skill" versionId="current" />;
}
