import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type DeploymentPairCommitResult as NativePairCommitResult,
  type DeploymentPairPreview as NativePairPreview,
  type DeploymentTarget as NativeDeploymentTarget,
  type AgentDirectoryProjection,
} from "../../api/bindings";
import { buildAgentDirectoryCardModels } from "../agents/agentCardModel";
import {
  pairOutcomeStatus as statusOf,
  type BatchDeploymentFacade,
  type BatchDeploymentResult,
  type BatchPreviewItem,
  type DeploymentBlockReason,
  type DeploymentMode,
  type DeploymentPairPreview,
  type DeploymentPreference,
  type DeploymentPreviewBatch,
  type DeploymentPreviewDisposition,
  type DeploymentTarget,
  type PairSelection,
  type PreviewConfirmations,
} from "./api";

function targetsResult(result: AppQueryResult): NativeDeploymentTarget[] {
  if (result.type !== "deployment_targets") {
    throw new Error("deployment.targets_unexpected_result");
  }
  return result.payload;
}

function directoryProjectionResult(result: AppQueryResult): AgentDirectoryProjection {
  if (result.type !== "agent_directory_projection") {
    throw new Error("deployment.directory_projection_unexpected_result");
  }
  return result.payload;
}

function previewResult(result: AppQueryResult) {
  if (result.type !== "deployment_batch_preview") {
    throw new Error("deployment.preview_unexpected_result");
  }
  return result.payload;
}

function commitResult(result: AppCommandResult) {
  if (result.type !== "deployment_preview_commit_result") {
    throw new Error("deployment.commit_unexpected_result");
  }
  return result.payload;
}

function toTarget(target: NativeDeploymentTarget): DeploymentTarget {
  return {
    id: target.id,
    label: target.label,
    path: target.path,
    available: target.available,
    physicalId: target.physical_id,
    modes: target.modes,
    agentClientId: target.agent_client_id ?? undefined,
    agentProfileId: target.agent_profile_id ?? undefined,
    sharedDirectory: target.shared_directory,
    sharedAgentBrands: target.shared_agent_brands,
    sharedAgentBrandKinds: target.shared_agent_brand_kinds,
    directoryStatus: target.directory_status ?? undefined,
    physicalIdentityVerified: target.physical_identity_verified,
    preferredMode: target.preferred_mode ?? undefined,
  };
}

function toPair(pair: NativePairPreview): DeploymentPairPreview {
  return {
    pairId: pair.pair_id,
    skillId: pair.skill_id,
    skillDisplayName: pair.skill_display_name,
    runtimeName: pair.runtime_name,
    targetLabel: pair.target_label,
    targetPath: pair.target_path,
    destinationPath: pair.destination_path,
    logicalTargetIds: pair.logical_target_ids,
    preference: pair.preference as DeploymentPreference,
    disposition: pair.disposition as DeploymentPreviewDisposition,
    mode: (pair.mode ?? null) as DeploymentMode | null,
    fallbackMode: (pair.fallback_mode ?? null) as DeploymentMode | null,
    blockReason: (pair.block_reason ?? null) as DeploymentBlockReason | null,
    warnings: pair.warnings,
    confirmationPreserved: pair.confirmation_preserved,
    confirmationFingerprint: pair.confirmation_fingerprint,
    technicalError: pair.technical_error ?? null,
  };
}

/** 结果行主文案：成功/跳过用稳定 i18n 键，失败原因由页面按结构化错误渲染。 */
function resultMessage(outcome: NativePairCommitResult["outcome"]): string {
  if (outcome === "deployed") return "deployment.results.status.message.succeeded";
  if (outcome === "no_change") return "deployment.results.status.message.succeeded";
  if (outcome === "excluded") return "deployment.results.status.message.skipped";
  if (outcome === "blocked") return "deployment.blockReason.committedBlocked";
  return "deployment.results.status.message.failed";
}

export function createNativeBatchDeploymentFacade(): BatchDeploymentFacade {
  const self = {
    listTargets: async (): Promise<DeploymentTarget[]> => {
      const [result, projectionResult] = await Promise.all([
        queryApplication({ type: "list_deployment_targets", payload: null }),
        queryApplication({ type: "get_agent_directory_projection", payload: null }),
      ]);
      const targets = targetsResult(result).map(toTarget);
      const models = buildAgentDirectoryCardModels(directoryProjectionResult(projectionResult));
      return targets.map((target) => {
        if (!target.agentClientId) return target;
        const role = target.sharedDirectory ? "shared_directory" : "agent_native";
        const model = models.find((candidate) =>
          candidate.directories.some((directory) =>
            directory.role === role && directory.physicalIdentityVerified
              && directory.physicalIdentityKey === target.physicalId)
          || candidate.directoryMembers?.some((member) => member.logical_target_id === target.id),
        );
        return model ? { ...target, cardModel: model } : target;
      });
    },

    ensureTargetDirectory: async (targetId: string): Promise<void> => {
      const result = await executeCommand({
        type: "ensure_agent_target_directory",
        payload: { target_id: targetId },
      });
      if (result.type !== "discovery_snapshot") throw new Error("deployment.ensure_target_unexpected_result");
    },

    listProjects: async () => {
      const result = await queryApplication({ type: "list_projects", payload: null });
      if (result.type !== "projects") throw new Error("deployment.projects_unexpected_result");
      return result.payload.map((project) => ({ id: project.id, agentIds: project.agent_ids ?? [] }));
    },

    async preview(
      items: BatchPreviewItem[],
      context?: { confirmations?: PreviewConfirmations; exclusions?: string[] },
    ): Promise<DeploymentPreviewBatch> {
      const result = await queryApplication({
        type: "get_deployment_batch_preview",
        payload: {
          items: items.map((item) => ({
            skill_id: item.skillId,
            version_id: item.versionId ?? null,
            runtime_name: null,
            logical_target_ids: item.targetIds,
            preference: item.preference,
          })),
          confirmations: context?.confirmations ?? {},
          exclusions: context?.exclusions ?? [],
        },
      });
      const payload = previewResult(result);
      return {
        previewId: payload.preview_id,
        expiresAt: payload.expires_at,
        pairs: payload.pairs.map(toPair),
        preservedConfirmationIds: payload.preserved_confirmation_ids,
      };
    },

    async commit(
      preview: DeploymentPreviewBatch,
      selections: PairSelection[],
      onProgress?: (completed: number) => void,
    ): Promise<BatchDeploymentResult[]> {
      const result = await executeCommand({
        type: "commit_deployment_preview",
        payload: {
          preview_id: preview.previewId,
          pairs: selections.map((selection) => ({
            pair_id: selection.pairId,
            confirm_fallback: selection.confirmFallback,
            exclude: selection.exclude,
          })),
        },
      });
      const payload = commitResult(result);
      const pairById = new Map(preview.pairs.map((pair) => [pair.pairId, pair]));
      const results = payload.pairs.map((pair): BatchDeploymentResult => {
        const facts = pairById.get(pair.pair_id);
        const status = statusOf(pair.outcome);
        const message = resultMessage(pair.outcome);
        return {
          skillId: facts?.skillId ?? "",
          displayName: facts?.skillDisplayName,
          targetId: facts?.logicalTargetIds[0] ?? "",
          label: facts?.targetLabel ?? pair.pair_id,
          status,
          message,
          error: pair.error ?? undefined,
          operationId: pair.operation_id ?? undefined,
        };
      });
      // 一次 IPC 返回全部 pair 结果；进度按可执行 pair 总数一次性落定。
      const executable = selections.filter((selection) => !selection.exclude).length;
      onProgress?.(executable);
      return results;
    },
  };
  return self;
}
