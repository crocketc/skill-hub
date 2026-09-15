import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ConflictCaseFact, GovernanceTaskFact, SourceRelationFact } from "../../api/bindings";
import type { SkillObservedDeployment, SkillProvenance } from "./api";
import { ProvenancePanel } from "./ProvenancePanel";

const provenance: SkillProvenance["provenance"] = {
  agentClientId: "trae.code",
  contentFingerprint: "sha256:aa11",
  importedAt: "1700000000",
  originalPath: "/agents/trae/skills/demo",
  ownership: "known_agent_target",
  sourceKind: "local",
  sourceLocator: "/agents/trae/skills/demo",
};

const observed: SkillObservedDeployment[] = [
  {
    clientId: "trae.code",
    contentFingerprint: "sha256:aa11",
    id: "obs-1",
    matchState: "content_verified",
    observedAt: "1700000100",
    originalPath: "/agents/trae/skills/demo",
    origin: "import",
    releasedAt: null,
    status: "active",
  },
  {
    clientId: "trae.code",
    contentFingerprint: "sha256:ff22",
    id: "obs-2",
    matchState: "diverged",
    observedAt: "1700000200",
    originalPath: "/agents/trae/skills/old",
    origin: "scan",
    releasedAt: "1700000300",
    status: "released",
  },
];

async function renderPanel(
  provenance: SkillProvenance["provenance"],
  rows: SkillObservedDeployment[],
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <ProvenancePanel observedDeployments={rows} provenance={provenance} />
    </I18nextProvider>,
  );
}

it("renders complete provenance facts and observed deployment annotations", async () => {
  await renderPanel(provenance, observed);

  expect(screen.getByTestId("import-provenance")).toBeVisible();
  expect(screen.getByText("本地目录")).toBeVisible();
  expect(screen.getAllByText("/agents/trae/skills/demo").length).toBeGreaterThan(0);
  expect(screen.getByText("已知 Agent 目录")).toBeVisible();
  // 关系逐条展示：已验证 + 观察中、已分叉 + 已收回，都标注不冒充。
  expect(screen.getAllByTestId("observed-deployment")).toHaveLength(2);
  expect(screen.getByText("内容一致")).toBeVisible();
  expect(screen.getByText("观察中")).toBeVisible();
  expect(screen.getByText("内容已分叉")).toBeVisible();
  expect(screen.getByText("已收回")).toBeVisible();
});

it("marks unknown attribution honestly instead of guessing", async () => {
  await renderPanel(
    provenance === null ? null : { ...provenance, agentClientId: null },
    [],
  );

  expect(screen.getByText("未识别（无目录证据，不猜测）")).toBeVisible();
  expect(screen.getByTestId("observed-absent")).toBeVisible();
});

it("shows the honest absent state for skills imported without provenance", async () => {
  await renderPanel(null, []);

  expect(screen.getByTestId("provenance-absent")).toBeVisible();
  expect(
    screen.getByText(/不是经由带存证的导入链路进入集中库/),
  ).toBeVisible();
  expect(screen.queryByTestId("import-provenance")).not.toBeInTheDocument();
});

const now = "2026-09-15T00:00:00Z";

function source(overrides: Partial<SourceRelationFact>): SourceRelationFact {
  return {
    provenance_id: "prov-1",
    skill_id: "skill-demo",
    directory_node_id: "node-native",
    agent_client_id: "trae.code",
    source_path: "/agents/trae/skills/demo",
    source_path_key: "pk-demo",
    relationship: "import_copy",
    file_representation: "directory",
    ownership: "observed_unmanaged",
    link_target_path: null,
    link_target_directory_id: null,
    content_fingerprint: "sha256:aa11",
    source: { kind: "local", locator: { local_path: "/agents/trae/skills/demo" } },
    imported_at: now,
    ...overrides,
  };
}

const task: GovernanceTaskFact = {
  task_id: "task-1",
  kind: "select_authoritative_version",
  subject_id: "conflict-1",
  detail: "两个同名副本需要选择权威版本",
  resolved: false,
  created_at: now,
  resolved_at: null,
};

async function renderPanelWithRelationship(
  sources: SourceRelationFact[],
  conflicts: ConflictCaseFact[],
  pendingTasks: GovernanceTaskFact[] = [task],
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <ProvenancePanel
        observedDeployments={[]}
        provenance={null}
        relationship={{
          conflicts,
          pendingTasks,
          sources,
        }}
      />
    </I18nextProvider>,
  );
}

it("lists multiple provenance sources with relationship and ownership labels", async () => {
  await renderPanelWithRelationship(
    [
      source({}),
      source({
        provenance_id: "prov-2",
        source_path: "/home/demo/.agents/skills/demo",
        source_path_key: "pk-shared-demo",
        directory_node_id: "node-shared",
        relationship: "shared_directory_read",
      }),
    ],
    [],
  );

  expect(screen.getByTestId("provenance-sources")).toBeVisible();
  expect(screen.getAllByTestId("provenance-source")).toHaveLength(2);
  expect(screen.getByText("/agents/trae/skills/demo")).toBeVisible();
  expect(screen.getByText("/home/demo/.agents/skills/demo")).toBeVisible();
  // 关系标签用用户语义；来源关系同样不会出现"外部链接"。
  expect(screen.getByText("导入副本")).toBeVisible();
  expect(screen.getByText("共享目录直接读取")).toBeVisible();
  expect(screen.getAllByText("观察到未纳管").length).toBe(2);
  expect(screen.queryByText(/外部链接/)).not.toBeInTheDocument();
});

it("shows conflict cases and governance todos without resolving them silently", async () => {
  await renderPanelWithRelationship(
    [source({})],
    [{
      conflict_id: "conflict-1",
      kind: "same_name_different_content",
      classification: "uncertain",
      member_skill_ids: ["skill-demo"],
      evidence: { fingerprints_match: false, names_match: true, sufficient_identity_evidence: false },
    }],
  );

  expect(screen.getByTestId("provenance-conflicts")).toBeVisible();
  expect(screen.getByTestId("provenance-conflict")).toBeVisible();
  expect(screen.getByText("证据不足（待办）")).toBeVisible();
  expect(screen.getByTestId("provenance-task")).toBeVisible();
  expect(screen.getByText("选择权威版本")).toBeVisible();
  expect(screen.getByText("两个同名副本需要选择权威版本")).toBeVisible();
});

it("keeps honest empty states when no sources or conflicts are registered", async () => {
  await renderPanelWithRelationship([], [], []);

  expect(screen.getByText("除当前集中库副本外，没有登记其他来源关系。")).toBeVisible();
  expect(screen.getByText("没有待处理的冲突或治理待办。")).toBeVisible();
});
