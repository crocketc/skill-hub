import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { GovernanceHistoryEntry, RemovalImpactFact } from "../../api/bindings";
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
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <RelationsPanel
          onLoadRemovalImpact={vi.fn(async () => impact)}
          relations={legacyRelations}
          relationship={relationship}
          {...props}
        />
      </I18nextProvider>
    </MemoryRouter>,
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
  const user = userEvent.setup();
  const onUndeploy = vi.fn();
  await renderPanel({ onUndeploy });

  expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "从 Codex CLI 移除" })).toBeVisible();
  // DEV-21-A：部署成功后「移除部署并恢复原状」在详情页可达——点击即进入移除流程。
  await user.click(screen.getByRole("button", { name: "从 Codex CLI 移除" }));
  expect(onUndeploy).toHaveBeenCalledWith(expect.objectContaining({ id: "deployment-1", label: "Codex CLI" }));
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

it("offers a governance deep link per governed relation when a builder is provided", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <RelationsPanel
          governanceHref={(relation) =>
            `/relationships/governance?from=library&skillId=skill-pdf&relationId=${relation.relationId}`}
          onLoadRemovalImpact={vi.fn().mockResolvedValue({} as RemovalImpactFact)}
          relations={legacyRelations}
          relationship={relationship}
        />
      </I18nextProvider>
    </MemoryRouter>,
  );

  // 每条治理关系行都带「管理关系」深链，携带来源与各自 relationId。
  const links = screen.getAllByTestId("governance-link");
  expect(links.length).toBeGreaterThan(0);
  const relCopyLink = links.find(
    (link) => link.getAttribute("href")?.includes("relationId=rel-copy"),
  );
  expect(relCopyLink).toBeDefined();
  expect(relCopyLink?.textContent).toBe("管理关系");
  expect(relCopyLink?.getAttribute("href")).toBe(
    "/relationships/governance?from=library&skillId=skill-pdf&relationId=rel-copy",
  );
});

// —— 任务 12C（12.6/12.13）：Skill 详情列出最近的不可变来源事件摘要 ——

function sourceEvent(overrides: Partial<GovernanceHistoryEntry>): GovernanceHistoryEntry {
  return {
    relation_id: "rel-copy",
    skill_id: "skill-pdf",
    skill_display_name: "PDF 阅读器",
    agent: { client_id: "codex-cli" },
    path: "C:/agents/codex/skills/pdf-reader",
    scope: "agent",
    project_id: null,
    action: "clean_source_copy",
    result: "committed",
    reason: null,
    operation_id: "op-1",
    occurred_at: "1727123456000",
    ...overrides,
  };
}

it("lists recent immutable source events newest-first with a view-all entry", async () => {
  await renderPanel({
    historyHref: "/relationships/governance/history",
    sourceEvents: [
      sourceEvent({
        relation_id: "rel-new",
        action: "retain_source_copy",
        result: "retained",
        occurred_at: "1727123500000",
      }),
      sourceEvent({ occurred_at: "1727123400000" }),
    ],
  });

  const section = screen.getByTestId("source-events");
  const items = within(section).getAllByTestId("source-event");
  expect(items).toHaveLength(2);
  // 新事件在前：保留动作先于清理动作。
  expect(items[0]?.textContent).toContain("保留来源副本");
  expect(items[1]?.textContent).toContain("清理来源副本");
  // 摘要只做展示；治理动作经「查看全部」/既有深链进入治理页，不在详情页复制流程。
  expect(
    within(section).getByRole("link", { name: "查看治理历史" }),
  ).toHaveAttribute("href", "/relationships/governance/history");
});

it("omits the source events section when no events are provided", async () => {
  await renderPanel({});

  expect(screen.queryByTestId("source-events")).not.toBeInTheDocument();
});
