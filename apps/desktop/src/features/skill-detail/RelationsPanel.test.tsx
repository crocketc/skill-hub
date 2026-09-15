import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import type { RemovalImpactFact } from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import type { SkillRelation } from "./api";
import { RelationsPanel } from "./RelationsPanel";
import type { SkillRelationshipViews } from "../relationshipGovernance/relationshipGovernance";

const legacyRelations: SkillRelation[] = [
  {
    affectedByCurrentVersion: true,
    id: "deployment-1",
    kind: "agent",
    label: "Codex CLI",
    logicalTarget: "codex-cli",
    physicalTarget: "C:/Users/demo/.codex/skills/pdf-reader",
    pinned: false,
    version: "v3",
  },
];

const relationship: SkillRelationshipViews = {
  sources: [],
  conflicts: [],
  pendingTasks: [],
  deployments: [
    {
      relationId: "rel-copy",
      skillId: "skill-pdf",
      directoryNodeId: "node-native",
      targetAgentClientId: "codex-cli",
      path: "C:/Users/demo/.codex/skills/pdf-reader",
      relationship: "managed_copy",
      fileRepresentation: "copy",
      ownership: "skillhub_managed",
      fingerprintState: "content_verified",
      linkTargetPath: null,
      linkTargetDirectoryId: null,
      active: true,
      actions: ["view_removal_impact"],
      pendingTaskIds: [],
    },
    {
      relationId: "rel-ref",
      skillId: "skill-notes",
      directoryNodeId: "node-native",
      targetAgentClientId: "codex-cli",
      path: "C:/Users/demo/.codex/skills/notes",
      relationship: "observed_link",
      fileRepresentation: "symbolic_link",
      ownership: "observed_unmanaged",
      fingerprintState: "name_only",
      linkTargetPath: "/home/demo/.agents/skills/notes",
      linkTargetDirectoryId: "node-shared",
      active: true,
      actions: ["view_removal_impact"],
      pendingTaskIds: [],
    },
    {
      relationId: "rel-old",
      skillId: "skill-old",
      directoryNodeId: "node-native",
      targetAgentClientId: "codex-cli",
      path: "C:/Users/demo/.codex/skills/old",
      relationship: "managed_link",
      fileRepresentation: "directory_junction",
      ownership: "skillhub_managed",
      fingerprintState: "diverged",
      linkTargetPath: null,
      linkTargetDirectoryId: null,
      active: false,
      actions: [],
      pendingTaskIds: [],
    },
  ],
};

const impact: RemovalImpactFact = {
  relation_id: "rel-copy",
  relation: null,
  ownership: "skillhub_managed",
  current_agent_reads_shared_directory: false,
  other_consumers: [],
  other_skill_paths: [],
  minimal_action: "convert_copy_to_managed_link",
  backup: { required: true, rollback_available: true, backup_location: "/backups/rel-copy", detail: "" },
  governance_tasks: [],
  permission_limited: false,
};

async function renderPanel(props: Partial<Parameters<typeof RelationsPanel>[0]> = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationsPanel
        onLoadRemovalImpact={vi.fn(async () => impact)}
        relations={legacyRelations}
        relationship={relationship}
        {...props}
      />
    </I18nextProvider>,
  );
}

it("renders governed deployment relations with user-facing relationship labels", async () => {
  await renderPanel();

  expect(screen.getByTestId("governed-relations")).toBeVisible();
  const rows = screen.getAllByTestId("governed-relation");
  expect(rows).toHaveLength(3);
  expect(screen.getByText("复制部署")).toBeVisible();
  expect(screen.getByText("识别到的链接")).toBeVisible();
  expect(screen.getByText("链接部署")).toBeVisible();
  // "外部链接"永远不是关系名称；已收回关系明确标注，不冒充活动关系。
  expect(screen.queryByText(/外部链接/)).not.toBeInTheDocument();
  expect(screen.getByText("已收回")).toBeVisible();
});

it("keeps the existing deployment rows and undeploy entries unchanged", async () => {
  const onUndeploy = vi.fn();
  await renderPanel({ onUndeploy });

  expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "从 Codex CLI 取消部署" })).toBeVisible();
});

it("opens the deterministic removal impact preview per governed relation", async () => {
  const user = userEvent.setup();
  const onLoadRemovalImpact = vi.fn(async () => impact);
  await renderPanel({ onLoadRemovalImpact });

  await user.click(screen.getAllByRole("button", { name: "查看移除影响" })[0]);

  const facts = await screen.findByTestId("removal-impact-facts");
  expect(facts.textContent).toContain("建议备份校验后转换为管理链接");
  expect(facts.textContent).toContain("可回退；备份位置：/backups/rel-copy");
  expect(onLoadRemovalImpact).toHaveBeenCalledWith("rel-copy");
});

it("states honest emptiness when the overview has no deployment relations", async () => {
  await renderPanel({ relationship: { conflicts: [], deployments: [], pendingTasks: [], sources: [] } });

  expect(screen.getByText("尚未登记部署关系事实。")).toBeVisible();
});
