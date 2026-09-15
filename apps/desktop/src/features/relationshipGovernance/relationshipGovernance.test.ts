import { expect, it } from "vitest";
import type {
  DeploymentRelationFact,
  DirectoryNodeFact,
  RelationshipOverview,
  SourceRelationFact,
} from "../../api/bindings";
import {
  buildAgentDirectoryViews,
  buildSkillRelationshipViews,
  conflictClassificationLabelKey,
  directoryRoleLabelKey,
  fileRepresentationLabelKey,
  fingerprintLabelKey,
  governanceTaskKindLabelKey,
  minimalImpactActionLabelKey,
  ownershipLabelKey,
  precedenceLabelKey,
  recognitionLabelKey,
  relationshipLabelKey,
  toRelationshipView,
} from "./relationshipGovernance";

const now = "2026-09-15T00:00:00Z";

function node(overrides: Partial<DirectoryNodeFact>): DirectoryNodeFact {
  return {
    agent_client_id: null,
    exists: true,
    observed_at: now,
    path: "/home/demo/.codex/skills",
    path_key: "pk-native",
    profile_id: "openai",
    node_id: "node-native",
    role: "agent_native",
    scan_source: "profile",
    ...overrides,
  };
}

function relation(overrides: Partial<DeploymentRelationFact>): DeploymentRelationFact {
  return {
    relation_id: "rel-copy",
    skill_id: "skill-review",
    agent_client_id: "codex-cli",
    path: "/home/demo/.codex/skills/review",
    path_key: "pk-review",
    directory_node_id: "node-native",
    relationship: "managed_copy",
    file_representation: "copy",
    ownership: "skillhub_managed",
    link_target_path: null,
    link_target_path_key: null,
    link_target_directory_id: null,
    content_fingerprint: "sha256:cc",
    origin: "scan",
    match_state: "content_verified",
    active: true,
    observed_at: now,
    released_at: null,
    ...overrides,
  };
}

function source(overrides: Partial<SourceRelationFact>): SourceRelationFact {
  return {
    provenance_id: "prov-1",
    skill_id: "skill-review",
    directory_node_id: "node-native",
    agent_client_id: "codex-cli",
    source_path: "/home/demo/.codex/skills/review",
    source_path_key: "pk-review",
    relationship: "import_copy",
    file_representation: "directory",
    ownership: "observed_unmanaged",
    link_target_path: null,
    link_target_directory_id: null,
    content_fingerprint: "sha256:cc",
    source: { kind: "local", locator: { local_path: "/home/demo/.codex/skills/review" } },
    imported_at: now,
    ...overrides,
  };
}

function overviewWith(overrides: Partial<RelationshipOverview> = {}): RelationshipOverview {
  return {
    scope: { type: "agent", value: { agent_client_id: "codex-cli" } },
    directory_nodes: [
      node({ node_id: "node-shared", path: "/home/demo/.agents/skills", path_key: "pk-shared", role: "shared_directory", profile_id: null, agent_client_id: null }),
      node({}),
    ],
    agent_directory_capabilities: [
      {
        agent_client_id: "codex-cli",
        directory_node_id: "node-shared",
        recognition: "supported",
        precedence: "preferred",
        evidence_reference: "https://developers.openai.com/codex/skills",
        researched_at: "2026-09-01",
        applicable_platforms: ["macos", "windows"],
      },
      {
        agent_client_id: "codex-cli",
        directory_node_id: "node-native",
        recognition: "unknown",
        precedence: "unknown",
        evidence_reference: null,
        researched_at: null,
        applicable_platforms: [],
      },
      {
        agent_client_id: "trae.code",
        directory_node_id: "node-shared",
        recognition: "unknown",
        precedence: "unknown",
        evidence_reference: null,
        researched_at: null,
        applicable_platforms: [],
      },
    ],
    source_relations: [],
    deployment_relations: [
      relation({ relation_id: "rel-read", skill_id: "skill-pdf", path: "/home/demo/.agents/skills/pdf", path_key: "pk-pdf", directory_node_id: "node-shared", relationship: "shared_directory_read", file_representation: "directory", ownership: "shared_reference" }),
      relation({ relation_id: "rel-ref", skill_id: "skill-notes", path: "/home/demo/.codex/skills/notes", path_key: "pk-notes", directory_node_id: "node-native", relationship: "shared_directory_reference", file_representation: "symbolic_link", ownership: "shared_reference", link_target_path: "/home/demo/.agents/skills/notes" }),
      relation({}),
    ],
    conflict_cases: [],
    pending_governance_tasks: [],
    agent_execution_confirmed: false,
    ...overrides,
  };
}

it("builds one card per directory, shared directory first, with honest recognition facts", () => {
  const views = buildAgentDirectoryViews(overviewWith(), { currentAgentClientId: "codex-cli" });

  expect(views.map((view) => view.directoryNodeId)).toEqual(["node-shared", "node-native"]);
  const shared = views[0];
  expect(shared.path).toBe("/home/demo/.agents/skills");
  expect(shared.recognition).toBe("supported");
  expect(shared.evidenceReference).toBe("https://developers.openai.com/codex/skills");
  // 通用共享目录卡片必须存在且角色可标识，识别状态只来自登记的能力事实。
  expect(directoryRoleLabelKey(shared.role)).toBe("relationshipGovernance.directoryRole.shared_directory");
});

it("counts unique active skills per directory and lists shared consumers", () => {
  const views = buildAgentDirectoryViews(overviewWith({
    deployment_relations: [
      relation({ relation_id: "rel-a", skill_id: "skill-pdf", directory_node_id: "node-shared" }),
      relation({ relation_id: "rel-b", skill_id: "skill-pdf", path: "/x/2", path_key: "pk-2", directory_node_id: "node-shared" }),
      relation({ relation_id: "rel-c", skill_id: "skill-notes", directory_node_id: "node-shared" }),
      relation({ relation_id: "rel-d", skill_id: "skill-old", directory_node_id: "node-shared", active: false }),
    ],
  }), { currentAgentClientId: "codex-cli" });

  const shared = views[0];
  // 同一 Skill 的两条关系只计一次；非活动关系不计入 Skill 数。
  expect(shared.skillCount).toBe(2);
  // 当前 Agent 自己不算共享消费者；识别该目录的其他 Agent 会出现。
  expect(shared.sharedConsumers).toEqual(["trae.code"]);
  expect(views[1].sharedConsumers).toEqual([]);
});

it("keeps directories without a registered capability as unconfirmed instead of guessing", () => {
  const views = buildAgentDirectoryViews(overviewWith({
    directory_nodes: [node({ node_id: "node-ghost", path: "/home/demo/.ghost/skills", path_key: "pk-ghost", exists: false })],
    agent_directory_capabilities: [],
    deployment_relations: [],
  }), { currentAgentClientId: "codex-cli" });

  const ghost = views[0];
  expect(ghost.recognition).toBeNull();
  expect(recognitionLabelKey(ghost.recognition)).toBe("relationshipGovernance.recognition.unregistered");
  expect(ghost.skillCount).toBe(0);
  expect(ghost.exists).toBe(false);
});

it("maps every deployment relation to a relationship view with user-facing label keys", () => {
  const view = toRelationshipView(relation({
    relationship: "managed_link",
    file_representation: "directory_junction",
    match_state: "name_only",
    link_target_path: "/home/demo/.agents/skills/review",
    link_target_directory_id: "node-shared",
  }), []);

  expect(view.relationship).toBe("managed_link");
  expect(relationshipLabelKey(view.relationship)).toBe("relationshipGovernance.relationship.managed_link");
  // 用户层标签只有链接部署/复制部署；符号链接与目录联接只在技术详情键中出现。
  expect(fileRepresentationLabelKey(view.fileRepresentation)).toBe("relationshipGovernance.fileRepresentation.directory_junction");
  expect(fingerprintLabelKey(view.fingerprintState)).toBe("relationshipGovernance.fingerprint.name_only");
  expect(ownershipLabelKey(view.ownership)).toBe("relationshipGovernance.ownership.skillhub_managed");
  // 链接目标是指向共享目录的确定性事实，供技术详情展示。
  expect(view.linkTargetPath).toBe("/home/demo/.agents/skills/review");
  expect(view.linkTargetDirectoryId).toBe("node-shared");
  // 活动关系至少提供移除影响入口；不虚构"转换已执行"。
  expect(view.actions).toContain("view_removal_impact");
  expect(view.pendingTaskIds).toEqual([]);
});

it("attaches governance tasks whose subject is the relation", () => {
  const tasks = [
    {
      task_id: "task-1",
      kind: "convert_copy_to_managed_link" as const,
      subject_id: "rel-copy",
      detail: "copy can be converted",
      resolved: false,
      created_at: now,
      resolved_at: null,
    },
    {
      task_id: "task-2",
      kind: "confirm_shared_directory_impact" as const,
      subject_id: "other-relation",
      detail: "unrelated",
      resolved: false,
      created_at: now,
      resolved_at: null,
    },
  ];
  const view = toRelationshipView(relation({}), tasks);
  expect(view.pendingTaskIds).toEqual(["task-1"]);
  expect(governanceTaskKindLabelKey("convert_copy_to_managed_link")).toBe(
    "relationshipGovernance.governanceTaskKind.convert_copy_to_managed_link",
  );
});

it("builds the skill scoped relationship view with multiple provenance sources, conflicts and todos", () => {
  const overview = overviewWith({
    scope: { type: "skill", value: { skill_id: "skill-review" } },
    source_relations: [
      source({ provenance_id: "prov-2", source_path: "/home/demo/.agents/skills/review", source_path_key: "pk-shared-review", directory_node_id: "node-shared", relationship: "shared_directory_read" }),
      source({}),
    ],
    deployment_relations: [relation({})],
    conflict_cases: [{
      conflict_id: "conflict-1",
      kind: "same_name_different_content",
      classification: "uncertain",
      member_skill_ids: ["skill-review"],
      evidence: { fingerprints_match: false, names_match: true, sufficient_identity_evidence: false },
    }],
    pending_governance_tasks: [{
      task_id: "task-1",
      kind: "select_authoritative_version",
      subject_id: "conflict-1",
      detail: "pick a version",
      resolved: false,
      created_at: now,
      resolved_at: null,
    }],
  });

  const view = buildSkillRelationshipViews(overview);
  // 多来源存证：同一 Skill 可以有不止一条来源关系，全部如实列出。
  expect(view.sources.map((row) => row.provenance_id)).toEqual(["prov-2", "prov-1"]);
  expect(view.deployments).toHaveLength(1);
  expect(view.conflicts).toHaveLength(1);
  expect(conflictClassificationLabelKey(view.conflicts[0].classification)).toBe(
    "relationshipGovernance.conflictClassification.uncertain",
  );
  expect(view.pendingTasks.map((task) => task.task_id)).toEqual(["task-1"]);
});

it("covers every minimal removal action with a label key", () => {
  expect(minimalImpactActionLabelKey("remove_current_agent_target")).toBe(
    "relationshipGovernance.minimalAction.remove_current_agent_target",
  );
  expect(minimalImpactActionLabelKey("remove_current_relation_keep_shared_files")).toBe(
    "relationshipGovernance.minimalAction.remove_current_relation_keep_shared_files",
  );
  expect(minimalImpactActionLabelKey("remove_current_shared_alias")).toBe(
    "relationshipGovernance.minimalAction.remove_current_shared_alias",
  );
  expect(minimalImpactActionLabelKey("convert_copy_to_managed_link")).toBe(
    "relationshipGovernance.minimalAction.convert_copy_to_managed_link",
  );
  expect(minimalImpactActionLabelKey("create_governance_task")).toBe(
    "relationshipGovernance.minimalAction.create_governance_task",
  );
});

it("maps precedence and directory roles deterministically", () => {
  expect(precedenceLabelKey("preferred")).toBe("relationshipGovernance.precedence.preferred");
  expect(precedenceLabelKey("lower_priority_copy")).toBe("relationshipGovernance.precedence.lower_priority_copy");
  expect(precedenceLabelKey("may_coexist")).toBe("relationshipGovernance.precedence.may_coexist");
  expect(precedenceLabelKey("unknown")).toBe("relationshipGovernance.precedence.unknown");
  expect(directoryRoleLabelKey("agent_native")).toBe("relationshipGovernance.directoryRole.agent_native");
  expect(directoryRoleLabelKey("central_library")).toBe("relationshipGovernance.directoryRole.central_library");
  expect(directoryRoleLabelKey("project")).toBe("relationshipGovernance.directoryRole.project");
  expect(recognitionLabelKey("supported")).toBe("relationshipGovernance.recognition.supported");
  expect(recognitionLabelKey("unknown")).toBe("relationshipGovernance.recognition.unknown");
  expect(recognitionLabelKey("unsupported")).toBe("relationshipGovernance.recognition.unsupported");
});
