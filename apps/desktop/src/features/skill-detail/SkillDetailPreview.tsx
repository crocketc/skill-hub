import { useState } from "react";
import type { RemovalImpactFact } from "../../api/bindings";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import { createPreviewSecurityFacade } from "../security/previewFacade";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";
import type { SkillDetailFacade, SkillMetadata, SkillMetadataPatch } from "./api";

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
        { id: "review-independent", label: "Codex 终端 · 独立副本", affected: false, pinned: true, version: "原有内容" },
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

export function SkillDetailPreview() {
  // §9 转正裁决：评审布局已是生产默认呈现；DEV 预览固定走内存评审门面。
  const [facade] = useState(() =>
    createReviewFacade(createMockSkillDetailFacade({
      relationshipOverview: previewRelationshipOverview,
      removalImpactFact: previewRemovalImpact,
    })),
  );
  const [markdownFacade] = useState(() => createMockMarkdownFacade());
  const [securityFacade] = useState(() => createPreviewSecurityFacade());
  return (
    <SkillDetailPage
      facade={facade}
      markdownFacade={markdownFacade}
      securityFacade={securityFacade}
    />
  );
}
