import { useState } from "react";
import type { RemovalImpactFact } from "../../api/bindings";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";

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
  const [facade] = useState(() =>
    createMockSkillDetailFacade({
      relationshipOverview: previewRelationshipOverview,
      removalImpactFact: previewRemovalImpact,
    }),
  );
  const [markdownFacade] = useState(() => createMockMarkdownFacade());
  return <SkillDetailPage facade={facade} markdownFacade={markdownFacade} />;
}
