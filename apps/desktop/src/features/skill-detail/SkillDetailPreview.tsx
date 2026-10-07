import { useState } from "react";
import type {
  RelationshipType,
  RelationGovernanceBatchOutcome,
  RelationGovernanceLedger,
  RelationGovernanceRow,
  RemovalImpactFact,
} from "../../api/bindings";
import type { RelationGovernanceFacade } from "../relationships/governance/api";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import { createPreviewSecurityFacade } from "../security/previewFacade";
import { removalImpactFixture, type RemovalFacade } from "../removal/api";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";
import type { SkillDetailFacade, SkillMetadata, SkillMetadataPatch } from "./api";

/**
 * 真实删除流（47bf9085）的 DEV 预览门面：用确定性影响夹具走完
 * 「影响预览 → 逐目标处置 → 确认 → 结果」对话框链路，不执行真实删除；
 * 真机由 nativeRemovalFacade 承载同一契约。
 */
const previewRemovalFacade: RemovalFacade = {
  async prepareDelete(skillId, skillName) {
    return { ...removalImpactFixture(), skillId, skillName: skillName ?? "PDF Reader" };
  },
  async commitDelete() {
    return { centralSkillDeleted: true, state: "committed", recoveryOperationId: null, items: [] };
  },
  async prepareUndeploy(deploymentId, label) {
    return { deploymentId, label, operationId: `preview-undeploy-${deploymentId}`, sharedTarget: false };
  },
  async commitUndeploy() {},
};

/** State is local to this opt-in preview; production and other fixtures keep their contracts. */
function createReviewFacade(base: SkillDetailFacade): SkillDetailFacade {
  const patches = new Map<string, SkillMetadataPatch>();
  const labels = new Map<string, string>();
  let restored = false;
  return {
    ...base,
    async getMetadata(skillId) {
      const metadata = await base.getMetadata(skillId);
      const patch = patches.get(skillId);
      if (!patch) return metadata;
      const next: SkillMetadata = {
        ...metadata,
        alias: patch.alias === null ? undefined : patch.alias ?? metadata.alias,
        purpose: patch.purpose ?? metadata.purpose,
        note: patch.note === null ? undefined : patch.note ?? metadata.note,
        tags: patch.tags ?? metadata.tags,
      };
      if (patch.translationText !== undefined) next.translation = patch.translationText === null ? undefined : { ...metadata.translation!, text: patch.translationText, userRevised: true };
      return next;
    },
    async saveMetadata(skillId, patch) { patches.set(skillId, { ...patches.get(skillId), ...patch }); },
    async setVersionLabel(_skillId, versionId, label) { labels.set(versionId, label); },
    async getVersions(skillId) {
      const versions = (await base.getVersions(skillId)).map((entry) => ({ ...entry, label: labels.get(entry.id) || entry.label, userLabel: labels.get(entry.id) }));
      return restored ? [{ ...versions[0], id: "review-restored-version", label: "恢复版本", origin: "rollback", current: true, createdAt: "2026-10-03T04:00:00Z" }, ...versions.map((entry) => ({ ...entry, current: false }))] : versions;
    },
    async getRollbackImpact(_skillId, targetVersionId) {
      return { rerunsBasicCheck: true, targetVersionId, deployments: [
        { id: "review-shared", label: "共享目录 · 受管链接", affected: true, pinned: false, version: "当前版本" },
        { id: "review-project", label: "文档协作项目 · 受管链接", affected: true, pinned: false, version: "当前版本" },
        { id: "review-independent", label: "Codex 终端 · 独立拷贝", affected: false, pinned: true, version: "原有内容" },
      ] };
    },
    async commitRollback() { restored = true; return { newVersionId: "review-restored-version" }; },
  };
}

/** DEV-only 关系事实：共享目录节点 + 复制部署关系 + 一条治理待办。 */
const previewRelationshipOverview = {
  scope: { type: "skill" as const, value: { skill_id: "skill-pdf" } },
  directory_nodes: [
    {
      agent_client_id: "auditor.cli",
      exists: true,
      node_id: "node-shared",
      observed_at: "0",
      path: "/Users/preview/.agents/skills",
      path_key: "pk-shared",
      profile_id: "agent-skills",
      role: "shared_directory" as const,
      scan_source: "preview",
    },
  ],
  agent_directory_capabilities: [
    {
      agent_client_id: "auditor.cli",
      applicable_platforms: ["macos"],
      directory_node_id: "node-shared",
      evidence_reference: "https://acme.example/docs",
      precedence: "preferred" as const,
      recognition: "supported" as const,
      researched_at: "2026-09-15",
    },
  ],
  source_relations: [],
  deployment_relations: [
    {
      active: true,
      agent_client_id: "auditor.cli",
      content_fingerprint: "sha256:preview-copy",
      directory_node_id: "node-shared",
      file_representation: "copy" as const,
      link_target_directory_id: null,
      link_target_path: null,
      link_target_path_key: null,
      match_state: "content_verified" as const,
      observed_at: "0",
      origin: "import" as const,
      ownership: "skillhub_managed" as const,
      path: "/Users/preview/.agents/skills/pdf",
      path_key: "pk-pdf",
      relation_id: "rel:skill-preview:copy",
      released_at: null,
      relationship: "managed_copy" as const,
      skill_id: "skill-pdf",
    },
  ],
  conflict_cases: [],
  pending_governance_tasks: [
    {
      created_at: "0",
      detail: "import.governance.task.convert_copy_to_managed_link",
      kind: "convert_copy_to_managed_link" as const,
      resolved: false,
      resolved_at: null,
      subject_id: "rel:skill-preview:copy",
      task_id: "task:skill-preview:copy",
    },
  ],
  agent_execution_confirmed: false as const,
};

const previewRemovalImpact: RemovalImpactFact = {
  backup: {
    backup_location: "/Users/preview/Library/SkillHub/backups/preview",
    detail: "preview",
    required: true,
    rollback_available: true,
  },
  current_agent_reads_shared_directory: false,
  governance_tasks: [],
  minimal_action: "convert_copy_to_managed_link",
  other_consumers: [],
  other_skill_paths: [],
  ownership: "skillhub_managed",
  permission_limited: false,
  relation: null,
  relation_id: "rel:skill-preview:copy",
};

/**
 * W3-5：DEV 预览的治理清单夹具——使用去向卡三种形态各一张（待集中管理
 * 独立副本、已集中管理共享目录、已集中管理项目），行事实与生产契约同构。
 * 批次方法返回一次性成功结果，仅服务预览交互，不承载生产行为。
 */
function deploymentRow(spec: {
  relationId: string;
  path: string;
  agentClientId: string;
  relationship: RelationshipType;
  takenOver: boolean;
  targetKind: "agent" | "project" | "shared_directory";
}): RelationGovernanceRow {
  return {
    relation: {
      kind: "deployment",
      fact: {
        relation_id: spec.relationId,
        skill_id: "skill-pdf",
        agent_client_id: spec.agentClientId,
        path: spec.path,
        path_key: spec.path.toLowerCase(),
        directory_node_id: "node-shared",
        relationship: spec.relationship,
        file_representation: spec.relationship === "managed_link" ? "symbolic_link" : "copy",
        ownership: spec.takenOver ? "skillhub_managed" : "observed_unmanaged",
        link_target_path: spec.takenOver ? "/Users/preview/SkillHub/skills/pdf" : null,
        link_target_path_key: spec.takenOver ? "/users/preview/skillhub/skills/pdf" : null,
        link_target_directory_id: spec.takenOver ? "node-library" : null,
        content_fingerprint: "sha256:preview-copy",
        origin: "import",
        match_state: "content_verified",
        health_reasons: [],
        active: true,
        observed_at: "0",
        released_at: null,
      },
    },
    skill_display_name: "PDF Reader",
    status: "normal",
    readiness: spec.takenOver ? "already_centralized" : "eligible_to_centralize",
    primary_action: spec.takenOver ? "undeploy" : "centralize_management",
    blockers: [],
    impact: { other_consumer_agent_ids: [], other_skill_paths: [], backup_required: true, rollback_available: true },
    governance: {
      governance_status: spec.takenOver ? "completed" : "pending",
      management_status: spec.takenOver ? "taken_over" : "not_taken_over",
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons: [],
      action_conditions: spec.takenOver
        ? [{ action: "undeploy", available: true, reasons: [] }]
        : [{ action: "centralize_management", available: true, reasons: [] }],
    },
    target_identity: spec.targetKind === "agent"
      ? null
      : { skill_id: "skill-pdf", target_kind: spec.targetKind, directory_node_id: "node-shared", entry_path_key: spec.path.toLowerCase() },
    source_read_only: false,
    evidence_relation_ids: [spec.relationId],
  };
}

const previewGovernanceRows: RelationGovernanceRow[] = [
  deploymentRow({
    relationId: "rel:skill-preview:copy",
    path: "/Users/preview/.agents/skills/pdf",
    agentClientId: "auditor.cli",
    relationship: "observed_copy",
    takenOver: false,
    targetKind: "agent",
  }),
  deploymentRow({
    relationId: "rel:skill-preview:managed-shared",
    path: "/Users/preview/.agents/shared/skills/pdf",
    agentClientId: "auditor.cli",
    relationship: "shared_directory_read",
    takenOver: true,
    targetKind: "shared_directory",
  }),
  deploymentRow({
    relationId: "rel:skill-preview:managed-project",
    path: "/Users/preview/Projects/文档协作/skills/pdf",
    agentClientId: "",
    relationship: "managed_link",
    takenOver: true,
    targetKind: "project",
  }),
];

function previewBatchOutcome(state: RelationGovernanceBatchOutcome["state"], relationId: string): RelationGovernanceBatchOutcome {
  return {
    batch_id: "preview-batch-1",
    action: "centralize_management",
    state,
    items: [{
      relation_id: relationId,
      operation_id: "preview-op-migrate-1",
      state: state === "committed" ? "committed" : "prepared",
      error_code: null,
      detail: null,
      retryable: true,
      rollback_available: true,
      backup_path: "/Users/preview/SkillHub/backups/preview",
      affected_paths: [],
      blockers: [],
    }],
    prepared_count: 1,
    committed_count: state === "committed" ? 1 : 0,
    failed_count: 0,
    blocked_count: 0,
    cancelled_count: 0,
    relationship_revision: "preview-relationship-revision",
  };
}

const previewGovernanceFacade: RelationGovernanceFacade = {
  async listGovernance() {
    const ledger: RelationGovernanceLedger = {
      rows: previewGovernanceRows,
      counts: {
        all: previewGovernanceRows.length,
        eligible_to_centralize: 1,
        needs_validation: 0,
        blocked: 0,
        status_normal: previewGovernanceRows.length,
        status_retained: 0,
        status_needs_validation: 0,
        status_needs_attention: 0,
        status_blocked: 0,
        source_copies: 0,
        deployments: previewGovernanceRows.length,
      },
      bucket: "all",
      total: previewGovernanceRows.length,
      relationship_revision: "preview-relationship-revision",
      last_verified_at: "0",
    };
    return ledger;
  },
  revalidate: async () => ({ items: [], relationship_revision: "preview-relationship-revision" }),
  async listHistory() {
    throw new Error("Preview facade does not serve governance history.");
  },
  async retainSourceCopy() {
    throw new Error("Preview facade does not execute retention.");
  },
  async revokeRetention() {
    throw new Error("Preview facade does not execute retention.");
  },
  async endRelationship() {
    throw new Error("Preview facade does not execute lifecycle actions.");
  },
  async relinkSourceCopy() {
    throw new Error("Preview facade does not execute relinks.");
  },
  async getRelationshipRemovalImpact(relationId) {
    return { ...previewRemovalImpact, relation_id: relationId };
  },
  async prepareGovernanceBatch(request) {
    return previewBatchOutcome("prepared", request.relationIds[0] ?? "");
  },
  async commitGovernanceBatch(_batchId, relationIds) {
    return previewBatchOutcome("committed", relationIds[0] ?? "");
  },
  async rollbackGovernanceBatch(_batchId, relationIds) {
    return previewBatchOutcome("committed", relationIds[0] ?? "");
  },
  async prepareRelationUndeploy() {
    throw new Error("Preview facade does not execute undeploys.");
  },
  async commitRelationUndeploy() {
    throw new Error("Preview facade does not execute undeploys.");
  },
};

export function SkillDetailPreview() {
  // §9 转正裁决：评审布局已是生产默认呈现；DEV 预览固定走内存评审门面。
  const [facade] = useState(() =>
    createReviewFacade(createMockSkillDetailFacade({
      relationshipOverview: previewRelationshipOverview,
      removalImpactFact: previewRemovalImpact,
      // W3-4：预览呈现有候选、有谱系的来源更新形态（静态真实形状，不执行命令）。
      sourceUpdateStatus: {
        skill_id: "skill-pdf",
        state: "update_available_with_local_changes",
        checked_at: "2026-10-05T08:00:00Z",
        upstream_label: "v2.5.0",
        candidate_identity: "tree:preview-candidate",
        ignored_candidates: [],
        candidate_ignored: false,
      },
      summary: {
        rootPath: "C:/Users/demo/SkillHub/skills/pdf-reader",
        upstreamLineage: {
          source_skill_id: "skill-doc",
          source_version_id: "version-100",
          source_display_name: "DOCX Writer",
          created_at: "1757808000",
        },
      },
    })),
  );
  const [markdownFacade] = useState(() => createMockMarkdownFacade());
  const [securityFacade] = useState(() => createPreviewSecurityFacade());
  return (
    <SkillDetailPage
      facade={facade}
      governanceFacade={previewGovernanceFacade}
      markdownFacade={markdownFacade}
      removalFacade={previewRemovalFacade}
      securityFacade={securityFacade}
    />
  );
}
