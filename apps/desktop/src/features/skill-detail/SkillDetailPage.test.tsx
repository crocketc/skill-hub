import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import {
  MemoryRouter,
  Route,
  useLocation,
  Routes,
  type InitialEntry,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import "../../styles/base.css";
import "./skill-detail.css";
import baseCss from "../../styles/base.css?raw";
import type { SkillDetailFacade } from "./api";
import type { MarkdownFacade } from "../markdown/api";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";
import type { RemovalFacade } from "../removal/api";
import { skillLibraryKeys } from "../skills/api";
import type {
  DeploymentRelationFact,
  RelationGovernanceBatchOutcome,
  RelationGovernanceLedger,
  RelationGovernanceRow,
  SourceUpdateStatus,
  UpstreamCheckResult,
} from "../../api/bindings";
import type { RelationGovernanceFacade } from "../relationships/governance/api";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { separateCheckFixture, type SecurityFacade } from "../security/api";
import type { SkillLibraryFacade, SkillLibraryQuery, SkillTableRow } from "../skills/api";
import { MOCK_SKILL_BROWSER, MOCK_SKILL_DOCX, MOCK_SKILL_PDF } from "../skills/testFixtures";

interface RenderDetailOptions {
  entry?: InitialEntry;
  directoryOpener?: { openDirectory: (path: string) => Promise<void> };
  facade?: SkillDetailFacade;
  governanceFacade?: RelationGovernanceFacade;
  libraryFacade?: Pick<SkillLibraryFacade, "listSkills">;
  locale?: "en-US" | "zh-CN";
  markdownFacade?: MarkdownFacade;
  removalFacade?: RemovalFacade;
  tracker?: OperationTracker;
  securityFacade?: SecurityFacade;
}

function createTestSecurityFacade(): SecurityFacade {
  const fixture = separateCheckFixture();
  return {
    getChecks: async () => fixture.checks,
    listFindings: async () => fixture.findings,
    setFindingDisposition: async () => undefined,
    getPreferences: async () => ({ llmProvider: "local-model", dataScope: "explicit_selection" }),
    runBasicCheck: async () => undefined,
    runLlmCheck: async () => undefined,
  };
}

/** W1-5（FB-①/D7-A）：相邻技能改由库列表前端推导，测试用有序库夹具承载顺序。 */
function createTestLibraryFacade(rows?: SkillTableRow[]) {
  const libraryRows =
    rows ??
    ([
      { ...MOCK_SKILL_DOCX, id: "skill-doc", name: "DOCX Writer" },
      MOCK_SKILL_PDF,
      { ...MOCK_SKILL_BROWSER, id: "skill-sheet", name: "Spreadsheet Reader" },
    ] satisfies SkillTableRow[]);
  const queries: SkillLibraryQuery[] = [];
  return {
    facade: {
      listSkills: async (query: SkillLibraryQuery) => {
        queries.push(query);
        return {
          facets: { tags: [] },
          items: libraryRows,
          page: query.page,
          pageSize: query.pageSize,
          total: libraryRows.length,
        };
      },
    },
    queries,
  };
}

async function renderDetail({
  entry = "/library/skill-pdf",
  directoryOpener,
  facade = createMockSkillDetailFacade(),
  governanceFacade = createTestGovernanceFacade(),
  libraryFacade = createTestLibraryFacade().facade,
  locale = "en-US",
  markdownFacade = createMockMarkdownFacade(),
  removalFacade,
  tracker,
  securityFacade = createTestSecurityFacade(),
}: RenderDetailOptions = {}) {
  const i18n = await createSkillHubI18n([locale]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[entry]}>
          <LocationProbe />
          <Routes>
            <Route
              element={<SkillDetailPage directoryOpener={directoryOpener} facade={facade} governanceFacade={governanceFacade} libraryFacade={libraryFacade} markdownFacade={markdownFacade} removalFacade={removalFacade} securityFacade={securityFacade} tracker={tracker} />}
              path="/library/:skillId"
            />
            <Route
              element={<SkillDetailPage directoryOpener={directoryOpener} facade={facade} governanceFacade={governanceFacade} libraryFacade={libraryFacade} markdownFacade={markdownFacade} removalFacade={removalFacade} securityFacade={securityFacade} tracker={tracker} />}
              path="/__preview/skill-detail/:skillId"
            />
            <Route element={<p>Library route</p>} path="/library" />
            <Route element={<SecurityProbe />} path="/library/:skillId/security" />
            <Route element={<DeploymentProbe />} path="/library/:skillId/deploy" />
            <Route element={<ExportProbe />} path="/settings/data-protection" />
            <Route element={<GovernanceProbe />} path="/relationships/governance" />
            <Route element={<p data-testid="agents-location">Agents route</p>} path="/agents" />
            <Route element={<p data-testid="projects-location">Projects route</p>} path="/projects" />
            <Route element={<p>Recovery route</p>} path="/recovery" />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { client };
}

function SecurityProbe() {
  const location = useLocation();
  return (
    <>
      <p data-testid="security-location">{location.pathname}</p>
      <output data-testid="security-state">{JSON.stringify(location.state)}</output>
    </>
  );
}

function DeploymentProbe() {
  const location = useLocation();
  return <p data-testid="deployment-location">{location.pathname}</p>;
}

// W3-5/W3-3b：使用去向卡治理入口必须携 Skill+关系身份与受控返回上下文进治理页。
function GovernanceProbe() {
  const location = useLocation();
  return (
    <>
      <p data-testid="governance-location">{location.pathname}</p>
      <p data-testid="governance-search">{location.search}</p>
      <output data-testid="governance-state">{JSON.stringify(location.state)}</output>
    </>
  );
}

// W3-3（§7.8 生产承载）：详情头部「转为集中管理」接真实治理契约。
// 候选行与批次结果都来自治理门面，不复制第二套执行状态机。
function governanceDeploymentFact(overrides: Partial<DeploymentRelationFact> = {}): DeploymentRelationFact {
  return {
    relation_id: "managed:dep-1",
    skill_id: "skill-pdf",
    agent_client_id: "codex",
    path: "C:/agents/codex/skills/pdf-reader",
    path_key: "c:/agents/codex/skills/pdf-reader",
    directory_node_id: "node-codex",
    relationship: "managed_copy",
    file_representation: "copy",
    ownership: "skillhub_managed",
    link_target_path: "C:/library/pdf-reader",
    link_target_path_key: "c:/library/pdf-reader",
    link_target_directory_id: "node-library",
    content_fingerprint: "sha256:aaa",
    origin: "import",
    match_state: "content_verified",
    active: true,
    observed_at: "1737600000000",
    released_at: null,
    ...overrides,
  };
}

function governanceRow(spec: {
  relationId: string;
  sharedImpactOnly?: boolean;
  /** W3-5：使用去向卡需要真实的接管状态与目标身份。 */
  takenOver?: boolean;
  targetKind?: "agent" | "project" | "shared_directory";
  path?: string;
  agentClientId?: string;
}): RelationGovernanceRow {
  const sharedImpactOnly = spec.sharedImpactOnly === true;
  const takenOver = spec.takenOver === true;
  const path = spec.path ?? "C:/agents/codex/skills/pdf-reader";
  const targetKind = spec.targetKind ?? "agent";
  return {
    relation: {
      kind: "deployment",
      fact: governanceDeploymentFact({
        relation_id: spec.relationId,
        path,
        path_key: path.toLowerCase(),
        agent_client_id: spec.agentClientId ?? "codex",
        relationship: takenOver ? "managed_link" : sharedImpactOnly ? "observed_copy" : "managed_copy",
        ownership: takenOver || !sharedImpactOnly ? "skillhub_managed" : "observed_unmanaged",
      }),
    },
    skill_display_name: "PDF Reader",
    status: sharedImpactOnly ? "needs_validation" : "normal",
    readiness: sharedImpactOnly ? "needs_validation" : "eligible_to_centralize",
    primary_action: sharedImpactOnly ? "revalidate" : "centralize_management",
    blockers: sharedImpactOnly ? ["shared_impact_confirmation_required"] : [],
    impact: {
      other_consumer_agent_ids: sharedImpactOnly ? ["cursor"] : [],
      other_skill_paths: [],
      backup_required: true,
      rollback_available: true,
    },
    governance: {
      governance_status: takenOver ? "completed" : "pending",
      management_status: takenOver ? "taken_over" : "not_taken_over",
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons: sharedImpactOnly ? ["shared_impact_confirmation_required"] : [],
      action_conditions: takenOver ? [] : [{
        action: "centralize_management",
        available: !sharedImpactOnly,
        reasons: sharedImpactOnly ? ["shared_impact_confirmation_required"] : [],
      }],
    },
    target_identity: targetKind === "agent"
      ? null
      : { skill_id: "skill-pdf", target_kind: targetKind, directory_node_id: `node-${spec.relationId}`, entry_path_key: path.toLowerCase() },
    source_read_only: false,
    evidence_relation_ids: [spec.relationId],
  };
}

function governanceLedger(rows: RelationGovernanceRow[]): RelationGovernanceLedger {
  return {
    rows,
    counts: {
      all: rows.length,
      eligible_to_centralize: rows.length,
      needs_validation: 0,
      blocked: 0,
      status_normal: rows.length,
      status_retained: 0,
      status_needs_validation: 0,
      status_needs_attention: 0,
      status_blocked: 0,
      source_copies: 0,
      deployments: rows.length,
    },
    bucket: "eligible_to_centralize",
    total: rows.length,
    relationship_revision: "rev-1",
    last_verified_at: null,
  };
}

function batchOutcome(
  state: RelationGovernanceBatchOutcome["state"],
  relationId: string,
): RelationGovernanceBatchOutcome {
  const committed = state === "committed";
  return {
    batch_id: "batch-1",
    action: "centralize_management",
    state,
    items: [{
      relation_id: relationId,
      operation_id: "op-migrate-1",
      state: committed ? "committed" : "prepared",
      error_code: null,
      detail: null,
      retryable: true,
      rollback_available: true,
      backup_path: "C:/backups/dep-1",
      affected_paths: [],
      blockers: [],
    }],
    prepared_count: 1,
    committed_count: committed ? 1 : 0,
    failed_count: 0,
    blocked_count: 0,
    cancelled_count: 0,
    relationship_revision: "rev-2",
  };
}

function createTestGovernanceFacade(
  rows: RelationGovernanceRow[] = [],
): RelationGovernanceFacade {
  return {
    listGovernance: vi.fn().mockResolvedValue(governanceLedger(rows)),
    revalidate: vi.fn(),
    listHistory: vi.fn(),
    retainSourceCopy: vi.fn(),
    revokeRetention: vi.fn(),
    endRelationship: vi.fn(),
    relinkSourceCopy: vi.fn(),
    getRelationshipRemovalImpact: vi.fn(),
    prepareGovernanceBatch: vi.fn().mockImplementation(
      async (request: { relationIds: string[] }) => batchOutcome("prepared", request.relationIds[0]),
    ),
    commitGovernanceBatch: vi.fn().mockImplementation(
      async (_batchId: string, relationIds: string[]) => batchOutcome("committed", relationIds[0]),
    ),
    rollbackGovernanceBatch: vi.fn(),
    prepareRelationUndeploy: vi.fn(),
    commitRelationUndeploy: vi.fn(),
  };
}

function ExportProbe() {
  const location = useLocation();
  return (
    <>
      <p data-testid="export-location">{location.pathname}</p>
      <output data-testid="export-state">{JSON.stringify(location.state)}</output>
    </>
  );
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="route-location">
      {`${location.pathname}${location.search}|${JSON.stringify(location.state)}`}
    </output>
  );
}

describe("SkillDetailPage shell", () => {
  beforeEach(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("renders the review experience as the default detail presentation", async () => {
    await renderDetail();

    expect(await screen.findByTestId("skill-detail-review")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "技能详情导航" });
    expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "概览",
      "内容与文件",
      "安全检查",
      "使用去向",
      "来源更新",
      "版本历史",
    ]);
  });

  it("opens the relationship graph focused on the current Skill", async () => {
    await renderDetail({ entry: "/library/skill-pdf" });

    fireEvent.click(await screen.findByRole("link", { name: /在图谱中查看/ }));

    expect(await screen.findByTestId("route-location")).toHaveTextContent(
      "/relationships?skillId=skill-pdf",
    );
  });

  it("routes the header dispatch action to the real deployment dialog instead of the demo flow", async () => {
    await renderDetail({ entry: "/library/skill-pdf" });

    fireEvent.click(await screen.findByRole("button", { name: "派发" }));

    expect(await screen.findByTestId("deployment-location")).toHaveTextContent(
      "/library/skill-pdf/deploy",
    );
    expect(screen.queryByText("选择派发目标")).not.toBeInTheDocument();
  });

  it("routes the header export action to the real standard export flow", async () => {
    await renderDetail({ entry: "/library/skill-pdf" });

    fireEvent.click(await screen.findByRole("button", { name: "导出" }));

    expect(await screen.findByTestId("export-location")).toHaveTextContent(
      "/settings/data-protection",
    );
    expect(screen.getByTestId("export-state")).toHaveTextContent(
      JSON.stringify({ exportSkillIds: ["skill-pdf"] }),
    );
    expect(screen.queryByText("标准 Skill ZIP")).not.toBeInTheDocument();
  });

  it("opens the real removal confirmation from the header delete action", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: "op-delete",
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [],
        dependentProjects: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({ centralSkillDeleted: true }),
    };
    await renderDetail({ removalFacade });

    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    expect(await screen.findByRole("button", { name: "Confirm deletion from library" })).toBeVisible();
    expect(removalFacade.prepareDelete).toHaveBeenCalledWith("skill-pdf", "PDF Reader");
    expect(screen.queryByText("本次示例影响")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();
  });

  // W3-3（§7.8 生产承载）：头部「转为集中管理」打开真实治理批次面板，
  // 经 prepare/commit 批命令执行；演示状态机（前端翻转徽标）已移除。
  it("runs the header takeover through the real governance batch contract", async () => {
    const tracker = createOperationTracker();
    const governanceFacade = createTestGovernanceFacade([
      governanceRow({ relationId: "managed:dep-1" }),
    ]);
    await renderDetail({ governanceFacade, tracker });

    fireEvent.click(await screen.findByRole("button", { name: "转为集中管理" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Bring the selection under skill library management",
    });
    fireEvent.click(within(dialog).getByTestId("governance-batch-confirm"));

    await waitFor(() => expect(governanceFacade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "centralize_management",
      confirmations: {},
      relationIds: ["managed:dep-1"],
    }));
    await waitFor(() => expect(governanceFacade.commitGovernanceBatch).toHaveBeenCalledWith("batch-1", ["managed:dep-1"]));
    expect(await screen.findByTestId("governance-batch-result")).toBeVisible();
    const trackerEntries = tracker.getSnapshot();
    // 父批次 + 逐项子任务都进 tracker；父批次对齐后端 batch_id 且成功。
    expect(trackerEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: "batch-1", status: "success" }),
    ]));
    // 演示确认弹层不再出现：接管确认绑定真实契约。
    expect(screen.queryByRole("button", { name: "确认转为集中管理" })).not.toBeInTheDocument();
    expect(screen.queryByText("接管内容基准")).not.toBeInTheDocument();
  });

  it("requires the shared impact confirmation before committing the takeover", async () => {
    const governanceFacade = createTestGovernanceFacade([
      governanceRow({ relationId: "managed:dep-shared", sharedImpactOnly: true }),
    ]);
    await renderDetail({ governanceFacade });

    fireEvent.click(await screen.findByRole("button", { name: "转为集中管理" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Bring the selection under skill library management",
    });
    const confirm = within(dialog).getByTestId("governance-batch-confirm");
    expect(confirm).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I confirm the shared-directory impact for PDF Reader/ }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(governanceFacade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "centralize_management",
      confirmations: { "managed:dep-shared": "shared_impact_confirmed" },
      relationIds: ["managed:dep-shared"],
    }));
  });

  it("hides the header takeover entry when the skill has no pending takeover relations", async () => {
    await renderDetail({ governanceFacade: createTestGovernanceFacade([]) });

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "转为集中管理" })).not.toBeInTheDocument();
  });

  // W3-5：使用去向卡由治理清单（单一事实来源）驱动，样例卡与演示弹层退场。
  it("renders usage destinations from the real governance ledger instead of demo cards", async () => {
    const governanceFacade = createTestGovernanceFacade([
      governanceRow({ relationId: "observed:codex-1", sharedImpactOnly: true }),
      governanceRow({
        relationId: "managed:dep-shared",
        takenOver: true,
        targetKind: "shared_directory",
        path: "C:/agents/shared/skills/pdf-reader",
      }),
    ]);
    await renderDetail({ governanceFacade });

    const destinations = await screen.findByLabelText("技能使用去向");
    const pending = within(destinations).getByTestId("usage-destination-observed:codex-1");
    expect(within(pending).getByText("待集中管理")).toBeVisible();
    expect(within(pending).getByText("C:/agents/codex/skills/pdf-reader")).toBeVisible();
    const managed = within(destinations).getByTestId("usage-destination-managed:dep-shared");
    expect(within(managed).getByText("已集中管理")).toBeVisible();
    expect(within(managed).getByText("C:/agents/shared/skills/pdf-reader")).toBeVisible();
    // 示例卡样例与演示弹层不再出现（主体位置区仍可真实呈现同路径事实，
    // 因此样例断言限定在使用去向容器内）。
    expect(within(destinations).queryByText("文档协作项目")).not.toBeInTheDocument();
    expect(within(destinations).queryByText("~/Agents/Codex/skills/pdf-reader")).not.toBeInTheDocument();
    expect(screen.queryByText(/已精确选中此目标上下文/)).not.toBeInTheDocument();
  });

  it("deep-links the card governance entry with skill and relation identity plus a return context", async () => {
    const governanceFacade = createTestGovernanceFacade([
      governanceRow({ relationId: "observed:codex-1", sharedImpactOnly: true }),
    ]);
    await renderDetail({ governanceFacade });

    const card = await screen.findByTestId("usage-destination-observed:codex-1");
    fireEvent.click(within(card).getByRole("button", { name: "查看治理详情" }));

    expect(await screen.findByTestId("governance-location")).toHaveTextContent("/relationships/governance");
    expect(screen.getByTestId("governance-search")).toHaveTextContent(
      "?from=library&skillId=skill-pdf&relationId=observed%3Acodex-1",
    );
    expect(screen.getByTestId("governance-state")).toHaveTextContent('{"returnTo":"/library/skill-pdf"}');
  });

  it("routes the card agent entry to the real Agent list", async () => {
    const governanceFacade = createTestGovernanceFacade([
      governanceRow({ relationId: "observed:codex-1", sharedImpactOnly: true }),
    ]);
    await renderDetail({ governanceFacade });

    const agentCard = await screen.findByTestId("usage-destination-observed:codex-1");
    fireEvent.click(within(agentCard).getByRole("button", { name: "进入 Agent" }));
    expect(await screen.findByTestId("agents-location")).toHaveTextContent("Agents route");
  });

  it("routes the card project entry to the real project list with a derived title", async () => {
    const governanceFacade = createTestGovernanceFacade([
      governanceRow({
        relationId: "observed:project-1",
        sharedImpactOnly: true,
        targetKind: "project",
        path: "C:/Projects/docs/skills/pdf-reader",
        agentClientId: "",
      }),
    ]);
    await renderDetail({ governanceFacade });

    const projectCard = await screen.findByTestId("usage-destination-observed:project-1");
    expect(within(projectCard).getByText("docs")).toBeVisible();
    fireEvent.click(within(projectCard).getByRole("button", { name: "进入项目" }));
    expect(await screen.findByTestId("projects-location")).toHaveTextContent("Projects route");
  });

  it("keeps the usage destinations honest when the ledger is empty", async () => {
    await renderDetail({ governanceFacade: createTestGovernanceFacade([]) });

    expect(await screen.findByTestId("usage-destinations-empty")).toBeVisible();
  });

  it("shows an explicit failure instead of demo cards when the governance ledger cannot load", async () => {
    const governanceFacade = createTestGovernanceFacade([]);
    vi.mocked(governanceFacade.listGovernance).mockRejectedValue(new Error("ledger unavailable"));
    await renderDetail({ governanceFacade });

    expect(await screen.findByTestId("usage-destinations-error")).toBeVisible();
    expect(screen.queryByLabelText("技能使用去向")).not.toBeInTheDocument();
  });

  it("provides the same actionable security review from full details", async () => {
    const fixture = separateCheckFixture();
    const runBasicCheck = vi.fn(async () => undefined);
    const securityFacade: SecurityFacade = {
      getChecks: async () => fixture.checks,
      listFindings: async () => fixture.findings,
      setFindingDisposition: async () => undefined,
      getPreferences: async () => ({ llmProvider: "local-model", dataScope: "explicit_selection" }),
      runBasicCheck,
      runLlmCheck: async () => undefined,
    };
    await renderDetail({ securityFacade });

    expect(await screen.findByRole("button", { name: "Run basic check" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run AI check" })).toBeVisible();
    expect(screen.getByText("发现疑似凭据字符串，请先确认来源。")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Run basic check" }));
    await waitFor(() => expect(runBasicCheck).toHaveBeenCalledWith("skill-pdf", "version-241"));
  });

  it("runs the security review against the concrete current version identity", async () => {
    const currentVersionId = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const detailFacade = createMockSkillDetailFacade();
    const getSummary = detailFacade.getSummary.bind(detailFacade);
    vi.spyOn(detailFacade, "getSummary").mockImplementation(async (skillId) =>
      Object.assign(await getSummary(skillId), { currentVersionId }),
    );
    const fixture = separateCheckFixture();
    const getChecks = vi.fn(async () => fixture.checks);
    const runBasicCheck = vi.fn(async () => undefined);
    const securityFacade: SecurityFacade = {
      getChecks,
      listFindings: async () => fixture.findings,
      setFindingDisposition: async () => undefined,
      getPreferences: async () => ({ llmProvider: "local-model", dataScope: "explicit_selection" }),
      runBasicCheck,
      runLlmCheck: async () => undefined,
    };

    await renderDetail({ facade: detailFacade, securityFacade });

    await waitFor(() => expect(getChecks).toHaveBeenCalledWith("skill-pdf", currentVersionId));
    fireEvent.click(screen.getByRole("button", { name: "Run basic check" }));
    await waitFor(() => expect(runBasicCheck).toHaveBeenCalledWith("skill-pdf", currentVersionId));
  });

  it("does not query or offer security checks when there is no current version", async () => {
    const detailFacade = createMockSkillDetailFacade();
    const getSummary = detailFacade.getSummary.bind(detailFacade);
    vi.spyOn(detailFacade, "getSummary").mockImplementation(async (skillId) =>
      Object.assign(await getSummary(skillId), { currentVersionId: undefined }),
    );
    const getChecks = vi.fn(async () => separateCheckFixture().checks);
    const securityFacade: SecurityFacade = {
      ...createTestSecurityFacade(),
      getChecks,
    };

    await renderDetail({ facade: detailFacade, securityFacade });

    expect(await screen.findByText("No version is available to check; security checks have not been run.")).toBeVisible();
    expect(getChecks).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Run basic check" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run AI check" })).not.toBeInTheDocument();
  });

  // 六裁决安全呈现（task C）：预警状态条 + 安全处理入口直达安全预警路由，
  // 事实来自 summary.securityAlert（W3-1 同源投影），并且安全区块的检查
  // 结果共享同一条预警记录。
  it("shows the security alert record and routes Security handling to the security route", async () => {
    const user = userEvent.setup();
    const libraryReturn = { focusSkillId: "skill-pdf", scrollLeft: 8, scrollTop: 216 };
    await renderDetail({
      entry: {
        pathname: "/library/skill-pdf",
        search: "?q=pdf",
        state: { libraryReturn },
      },
      facade: createMockSkillDetailFacade({ summary: { securityAlert: "warning" } }),
    });

    const alerts = await screen.findAllByRole("status", { name: "Security handling record" });
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]).toHaveTextContent("The current version is under a security alert");

    await user.click(screen.getAllByRole("button", { name: "Security handling" })[0]);

    expect(await screen.findByTestId("security-location")).toHaveTextContent("/library/skill-pdf/security");
    expect(screen.getByTestId("security-state")).toHaveTextContent(JSON.stringify({ libraryReturn }));
  });

  it("omits the security alert record when no alert is active", async () => {
    await renderDetail();

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "Security handling record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Security handling" })).not.toBeInTheDocument();
  });

  it("loads deletion impact from the W3-1 removal request and returns to the library after confirmation", async () => {
    const tracker = createOperationTracker();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: "op-delete",
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [],
        dependentProjects: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({ centralSkillDeleted: true }),
    };
    const { client } = await renderDetail({
      entry: { pathname: "/library/skill-pdf", state: { removalRequest: { skillId: "skill-pdf" } } },
      removalFacade,
      tracker,
    });
    client.setQueryData(skillLibraryKeys.root, { cached: true });

    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(removalFacade.prepareDelete).toHaveBeenCalledWith("skill-pdf", "PDF Reader");
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion from library" }));

    await waitFor(() => expect(removalFacade.commitDelete).toHaveBeenCalledWith("op-delete", {}));
    expect(tracker.getSnapshot()).toEqual([
      expect.objectContaining({ operationId: "op-delete", status: "success" }),
    ]);
    expect(client.getQueryState(skillLibraryKeys.root)?.isInvalidated).toBe(true);
    expect(await screen.findByText("Library route")).toBeVisible();
  });

  // K2/G-07 故障矩阵：delete_skill 失败（centralSkillDeleted=false）时不得抛出
  // 原始错误或冒充成功，也不导航回列表——渲染逐项目标结果面板：目标使用
  // prepare 返回的显示名（绝不裸露 deployment_id），标题明示「目标已回收，
  // 中央 Skill 未删除」，失败原因经统一映射可读，恢复入口携带
  // recovery_operation_id 深链进入恢复中心。
  it("renders the per-target outcome panel with a recovery entry when the central delete fails", async () => {
    const tracker = createOperationTracker();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: "op-delete",
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [
          { id: "dep-1", label: "Codex CLI", path: "C:/codex/skills/pdf-reader", physicalId: "codex" },
          { id: "dep-2", label: "Claude Code", path: "C:/claude/skills/pdf-reader", physicalId: "claude" },
        ],
        dependentProjects: [],
        declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({
        centralSkillDeleted: false,
        state: "partially_committed",
        recoveryOperationId: "op-restore-1",
        centralDeleteError: "internal.error",
        items: [
          { deploymentId: "dep-1", status: "applied" },
          { deploymentId: "dep-2", status: "failed", errorCode: "operation_conflict" },
        ],
      }),
    };
    const { client } = await renderDetail({
      entry: { pathname: "/library/skill-pdf", state: { removalRequest: { skillId: "skill-pdf" } } },
      removalFacade,
      tracker,
    });
    client.setQueryData(skillLibraryKeys.root, { cached: true });

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Target copy handling：C:\\codex\\skills\\pdf-reader" }),
      { target: { value: "keep_deployed" } },
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Target copy handling：C:\\claude\\skills\\pdf-reader" }),
      { target: { value: "remove_deployment" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm deletion from library" }));

    const panel = await screen.findByTestId("removal-outcome-result");
    expect(panel).toBeVisible();
    expect(screen.getByTestId("removal-outcome-title")).toHaveTextContent(
      "Targets were removed, but the library Skill was not deleted.",
    );
    expect(within(panel).getByText("Codex CLI")).toBeVisible();
    expect(within(panel).getByText("Claude Code")).toBeVisible();
    expect(within(panel).queryByText("dep-1")).not.toBeInTheDocument();
    expect(within(panel).getByText(/operation conflicts with another/)).toBeVisible();
    expect(screen.queryByText(/central skill was not deleted/)).not.toBeInTheDocument();
    // tracker 如实记失败，不冒充成功；也不导航回列表。
    const [finished] = tracker.getSnapshot();
    expect(finished.status).toBe("failed");
    expect(finished.resultSummary).toEqual({ succeeded: 0, failed: 1, skipped: 0 });
    expect(screen.getByTestId("route-location")).toHaveTextContent("/library/skill-pdf");
    fireEvent.click(screen.getByTestId("removal-outcome-recovery"));
    expect(screen.getByTestId("route-location")).toHaveTextContent("/recovery?operationId=op-restore-1");
  });

  // 继续处理入口：按契约先重新 prepare（原确认已消费），再重新确认。
  it("re-prepares the deletion impact from the outcome panel continue entry", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: "op-delete",
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [
          { id: "dep-1", label: "Codex CLI", path: "C:/codex/skills/pdf-reader", physicalId: "codex" },
        ],
        dependentProjects: [],
        declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({
        centralSkillDeleted: false,
        state: "partially_committed",
        centralDeleteError: "internal.error",
        items: [{ deploymentId: "dep-1", status: "failed", errorCode: "operation_conflict" }],
      }),
    };
    await renderDetail({
      entry: { pathname: "/library/skill-pdf", state: { removalRequest: { skillId: "skill-pdf" } } },
      removalFacade,
    });

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Target copy handling：C:\\codex\\skills\\pdf-reader" }),
      { target: { value: "keep_deployed" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm deletion from library" }));
    await screen.findByTestId("removal-outcome-result");

    fireEvent.click(screen.getByTestId("removal-outcome-continue"));
    await waitFor(() => expect(removalFacade.prepareDelete).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.queryByTestId("removal-outcome-result")).not.toBeInTheDocument();
  });

  it("cancels deletion without committing a prepared operation", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: "op-delete",
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [],
        dependentProjects: [],
      }),
      commitDelete: vi.fn(),
    };
    await renderDetail({
      entry: { pathname: "/library/skill-pdf", state: { removalRequest: { skillId: "skill-pdf" } } },
      removalFacade,
    });

    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removalFacade.commitDelete).not.toHaveBeenCalled();
  });

  // K2/G-10：删除影响查询失败必须可见失败并停止流程——错误进 alert，
  // 确认对话框（含确认按钮）完全不出现，commit 不被调用。
  it("shows the load failure visibly and never opens the confirm dialog when impact preparation fails", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockRejectedValue({
        code: "removal.deployment_target_unavailable", severity: "error", params: {}, actions: [],
      }),
      commitDelete: vi.fn(),
    };
    await renderDetail({
      entry: { pathname: "/library/skill-pdf", state: { removalRequest: { skillId: "skill-pdf" } } },
      removalFacade,
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Deployment target details could not be verified, so deletion was not prepared.",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removalFacade.commitDelete).not.toHaveBeenCalled();
  });

  // K2 预览失效边界：prepared 丢失（operationId 缺省）时提交必须被拒，
  // 用户看到「预览已失效，请重新确认」，绝不静默 no-op。
  it("rejects the commit with re-preview guidance when the prepared operation is missing", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: undefined,
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [],
        dependentProjects: [],
      }),
      commitDelete: vi.fn(),
    };
    await renderDetail({
      entry: { pathname: "/library/skill-pdf", state: { removalRequest: { skillId: "skill-pdf" } } },
      locale: "zh-CN",
      removalFacade,
    });

    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认从库中删除" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("预览已失效，请重新确认。");
    expect(removalFacade.commitDelete).not.toHaveBeenCalled();
  });

  // W3-1（FB-003 裁决第 1 节）：只响应当前 Skill 的 removalRequest。
  it("ignores a removal request addressed to another skill", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn(),
      commitDelete: vi.fn(),
    };
    await renderDetail({
      entry: { pathname: "/library/skill-pdf", state: { removalRequest: { skillId: "skill-other" } } },
      locale: "en-US",
      removalFacade,
    });

    await screen.findByRole("heading", { level: 1, name: "PDF Reader" });
    expect(removalFacade.prepareDelete).not.toHaveBeenCalled();
  });

  it("returns to the Skill library with the drawer reopen context carried in the search", async () => {
    await renderDetail({
      entry: {
        pathname: "/library/skill-pdf",
        search: "?q=pdf&sort=version:desc",
        state: {
          libraryReturn: {
            focusSkillId: "skill-pdf",
            scrollLeft: 0,
            scrollTop: 416,
          },
        },
      },
    });

    const back = await screen.findByRole("link", { name: "返回技能库" });
    expect(back).toHaveAttribute(
      "href",
      "/library?q=pdf&sort=version%3Adesc&skill=skill-pdf",
    );
    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  });

  it("returns to the preview Skill library instead of the unavailable production route", async () => {
    await renderDetail({
      entry: {
        pathname: "/__preview/skill-detail/skill-pdf",
        search: "?q=pdf",
        state: {
          libraryReturn: {
            focusSkillId: "skill-pdf",
            scrollLeft: 0,
            scrollTop: 416,
          },
        },
      },
    });

    expect(await screen.findByRole("link", { name: "返回技能库" })).toHaveAttribute(
      "href",
      "/__preview/skill-library?q=pdf&skill=skill-pdf",
    );
    expect(screen.getByRole("link", { name: "Next Skill" })).toHaveAttribute(
      "href",
      "/__preview/skill-detail/skill-sheet?q=pdf",
    );
  });

  it("carries the library return context through an adjacent Skill", async () => {
    const libraryReturn = { focusSkillId: "skill-pdf", scrollLeft: 12, scrollTop: 416 };
    const user = userEvent.setup();
    await renderDetail({
      entry: {
        pathname: "/library/skill-pdf",
        search: "?q=pdf&sort=name",
        state: { libraryReturn },
      },
    });

    await user.click(await screen.findByRole("link", { name: "Next Skill" }));

    expect(await screen.findByRole("heading", { name: "Spreadsheet Reader" })).toBeVisible();
    expect(screen.getByTestId("route-location")).toHaveTextContent(
      `/library/skill-sheet?q=pdf&sort=name|${JSON.stringify({ libraryReturn })}`,
    );
  });

  it("omits fabricated previous and next controls on direct entry", async () => {
    await renderDetail();

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Previous Skill" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Next Skill" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the library query when navigating to an adjacent Skill", async () => {
    await renderDetail({ entry: "/library/skill-pdf?q=pdf&sort=version:desc" });

    expect(await screen.findByRole("link", { name: "Previous Skill" })).toHaveAttribute(
      "href",
      "/library/skill-doc?q=pdf&sort=version%3Adesc",
    );
    expect(screen.getByRole("link", { name: "Next Skill" })).toHaveAttribute(
      "href",
      "/library/skill-sheet?q=pdf&sort=version%3Adesc",
    );
  });

  it("derives adjacent order from the library list results", async () => {
    const library = createTestLibraryFacade([
      { ...MOCK_SKILL_DOCX, id: "skill-sheet", name: "Spreadsheet Reader" },
      MOCK_SKILL_PDF,
      { ...MOCK_SKILL_BROWSER, id: "skill-doc", name: "DOCX Writer" },
    ]);
    await renderDetail({
      entry: "/library/skill-pdf?q=pdf&sort=name:desc",
      libraryFacade: library.facade,
    });

    expect(await screen.findByRole("link", { name: "Previous Skill" })).toHaveAttribute(
      "href",
      "/library/skill-sheet?q=pdf&sort=name%3Adesc",
    );
    expect(screen.getByRole("link", { name: "Next Skill" })).toHaveAttribute(
      "href",
      "/library/skill-doc?q=pdf&sort=name%3Adesc",
    );
    // 推导必须沿用库查询上下文（筛选/排序），分页取全量有序结果，不另造第二套排序。
    expect(library.queries[0]).toMatchObject({
      page: 1,
      pageSize: 100,
      sort: { column: "name", direction: "desc" },
      text: "pdf",
    });
  });

  it("hides adjacent controls when the Skill is absent from the library results", async () => {
    const library = createTestLibraryFacade([{ ...MOCK_SKILL_DOCX, id: "skill-doc" }]);
    await renderDetail({
      entry: "/library/skill-pdf?q=pdf",
      libraryFacade: library.facade,
    });

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Previous Skill" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Next Skill" }),
    ).not.toBeInTheDocument();
  });

  it("updates the preview detail and keeps adjacent controls after navigation", async () => {
    await renderDetail({ entry: "/__preview/skill-detail/skill-pdf" });

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Next Skill" }));

    expect(await screen.findByRole("heading", { name: "Spreadsheet Reader" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Read spreadsheet data safely" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous Skill" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next Skill" })).toBeDisabled();
  });

  it("renders adjacent controls as a compact horizontal navigation", async () => {
    await renderDetail({ entry: "/__preview/skill-detail/skill-pdf" });

    const navigation = await screen.findByRole("navigation", { name: "Skill navigation" });
    expect(navigation).toHaveClass("sh-skill-detail__adjacent");
    expect(navigation.querySelectorAll("a")).toHaveLength(2);
    expect(baseCss).toMatch(/\.sh-skill-detail__adjacent\s*\{[\s\S]*display:\s*flex/);
    expect(baseCss).toMatch(/\.sh-skill-detail__adjacent\s*\{[\s\S]*flex-direction:\s*row/);
  });

  it("places adjacent Skill controls after the review section navigation in the rail", async () => {
    await renderDetail({ entry: "/__preview/skill-detail/skill-pdf" });

    const sections = await screen.findByRole("navigation", { name: "技能详情导航" });
    const adjacent = await screen.findByRole("navigation", { name: "Skill navigation" });
    expect(sections.compareDocumentPosition(adjacent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(adjacent.parentElement).toBe(sections.parentElement);
  });

  it("recovers from a summary failure without leaving the detail route", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({ failSummaryOnce: true }),
    });

    expect(await screen.findByText("Unable to load Skill details")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  });

  it("shows an explicit empty state when the Skill no longer exists", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({ missingSkill: true }),
    });

    expect(await screen.findByText("This Skill is not in the local library")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("highlights the review section selected from the section navigation", async () => {
    const user = userEvent.setup();
    await renderDetail();

    const navigation = await screen.findByRole("navigation", { name: "技能详情导航" });
    const safetyLink = within(navigation).getByRole("link", { name: "安全检查" });
    await user.click(safetyLink);

    expect(safetyLink).toHaveAttribute("aria-current", "location");
  });

  // jsdom 未实现 scrollIntoView：直接替换原型方法并在结束后移除。
  function stubScrollIntoView(): { calls: Element[]; restore: () => void } {
    const calls: Element[] = [];
    const mock = vi.fn(function (this: Element) {
      calls.push(this);
    });
    Element.prototype.scrollIntoView = mock as unknown as typeof Element.prototype.scrollIntoView;
    return {
      calls,
      restore: () => {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      },
    };
  }

  it("lands review-section deep links by scrolling the hashed zone into view", async () => {
    const stub = stubScrollIntoView();
    try {
      await renderDetail({ entry: "/library/skill-pdf#review-versions" });

      // 分区内容渲染完成后深链才落位；被滚动到视口的正是版本历史分区。
      await waitFor(() => {
        expect(stub.calls.some((element) => element.id === "review-versions")).toBe(true);
      });
    } finally {
      stub.restore();
    }
  });

  it("does not scroll for hashes outside the review sections", async () => {
    const stub = stubScrollIntoView();
    try {
      await renderDetail({ entry: "/library/skill-pdf#description" });

      await screen.findByRole("heading", { name: "PDF Reader" });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it("loads the editable metadata panel in the overview section", async () => {
    await renderDetail();
    // P1-12 + 评审呈现：原文与译文为次级展示，评审布局下默认展开。
    await screen.findByText("Original text and translation");
    expect(screen.getByText("Original description")).toBeVisible();
    expect(screen.getByText("模型译文")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit My purpose" })).toBeVisible();
  });

  it("shows the read-only invocation policy and declared runtime requirements in the detail page", async () => {
    await renderDetail();

    expect(await screen.findByText("Model and user")).toBeVisible();
    expect(screen.queryByText("pdf-reader <file>")).not.toBeInTheDocument();
    expect(screen.getByText("Poppler")).toBeVisible();
    expect(screen.getByText("Executable used for PDF rendering")).toBeVisible();
  });
});

// W3-4：来源更新区接真实五命令（getSourceUpdateStatus / checkSourceUpdate /
// prepareSourceUpdate+commitSourceUpdate / ignoreSourceUpdate / relinkSource），
// 删除六个 DEV 场景模拟按钮；候选、状态与谱系全部来自门面事实，不再伪造
// 来源名称或结果文案。
describe("SkillDetailPage source updates real commands (W3-4)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  const sourcesSection = async () => {
    const section = await waitFor(() => {
      const el = document.getElementById("review-sources");
      if (!el) throw new Error("review-sources section not mounted yet");
      return el;
    });
    return within(section);
  };

  const candidateStatus: SourceUpdateStatus = {
    skill_id: "skill-pdf",
    state: "update_available",
    checked_at: "2026-10-05T08:00:00Z",
    upstream_label: "v2.5.0",
    candidate_identity: "tree:abc",
    ignored_candidates: [],
    candidate_ignored: false,
  };

  it("renders the persisted status and candidate actions without fabricated source names", async () => {
    const facade = createMockSkillDetailFacade({ sourceUpdateStatus: candidateStatus });
    await renderDetail({ facade });

    const section = await sourcesSection();
    expect(await section.findByText("发现可采用的更新候选（v2.5.0）。")).toBeVisible();
    expect(section.getByRole("button", { name: "预览采用影响" })).toBeVisible();
    expect(section.getByRole("button", { name: "忽略本次更新" })).toBeVisible();
    expect(section.getByRole("button", { name: "更换来源" })).toBeVisible();
    // 原型示例仓库名不得再出现；来源展示只来自门面事实。
    expect(screen.queryByText("PDF Reader 官方维护仓库")).not.toBeInTheDocument();
  });

  it("runs a real check through the facade and reports the result", async () => {
    const facade = createMockSkillDetailFacade({
      sourceUpdateResult: {
        skill_id: "skill-pdf",
        state: "up_to_date",
        local_version: null,
        upstream_version: null,
        upstream_label: "v1.4.0",
      } satisfies UpstreamCheckResult,
    });
    await renderDetail({ facade });

    const section = await sourcesSection();
    fireEvent.click(await section.findByRole("button", { name: "检查更新" }));

    expect(await section.findByText("来源检查完成：已是最新。")).toBeVisible();
    expect(facade.calls.checkedSourceUpdates).toEqual([{ skillId: "skill-pdf" }]);
  });

  it("prepares the real preview and commits the confirmed adoption", async () => {
    const facade = createMockSkillDetailFacade({ sourceUpdateStatus: candidateStatus });
    await renderDetail({ facade });

    const section = await sourcesSection();
    fireEvent.click(await section.findByRole("button", { name: "预览采用影响" }));

    expect(facade.calls.preparedSourceUpdates).toEqual([{ skillId: "skill-pdf" }]);
    expect(await screen.findByRole("dialog", { name: "采用更新影响预览" })).toBeVisible();
    // 预览对话框列出门面返回的文件级变更，不编造版本号或影响项。
    expect(screen.getByText("SKILL.md（修改）")).toBeVisible();
    expect(screen.getByText("scripts/run.py（新增）")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "确认采用更新" }));

    expect(await section.findByText("已采用来源更新并创建新版本。")).toBeVisible();
    expect(facade.calls.committedSourceUpdates).toEqual([
      { previewId: "preview-1", decision: "take_upstream" },
    ]);
    expect(screen.queryByRole("dialog", { name: "采用更新影响预览" })).not.toBeInTheDocument();
  });

  it("ignores the current candidate by its identity", async () => {
    const facade = createMockSkillDetailFacade({ sourceUpdateStatus: candidateStatus });
    await renderDetail({ facade });

    const section = await sourcesSection();
    fireEvent.click(await section.findByRole("button", { name: "忽略本次更新" }));

    await waitFor(() => {
      expect(facade.calls.ignoredSourceUpdates).toEqual([
        { skillId: "skill-pdf", candidateIdentity: "tree:abc" },
      ]);
    });
  });

  it("relinks an update source with an explicit user-chosen kind", async () => {
    const facade = createMockSkillDetailFacade({
      sourceUpdateStatus: { ...candidateStatus, state: "no_upstream", checked_at: null, upstream_label: null, candidate_identity: null },
    });
    await renderDetail({ facade });

    const section = await sourcesSection();
    expect(await section.findByText(/没有可检查更新的上游来源/)).toBeVisible();
    fireEvent.click(section.getByRole("button", { name: "关联更新来源" }));

    expect(await screen.findByRole("dialog", { name: "关联网络更新来源" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("来源地址"), {
      target: { value: "https://example.com/org/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认关联" }));

    await waitFor(() => {
      expect(facade.calls.relinkSourceInputs).toEqual([
        { skillId: "skill-pdf", source: { kind: "https", value: "https://example.com/org/repo" } },
      ]);
    });
    expect(screen.queryByRole("dialog", { name: "关联网络更新来源" })).not.toBeInTheDocument();
  });

  it("keeps the relink dialog open with a readable error when the command fails", async () => {
    const facade = createMockSkillDetailFacade({
      sourceUpdateStatus: { ...candidateStatus, state: "no_upstream", checked_at: null, upstream_label: null, candidate_identity: null },
      failRelinkSource: true,
    });
    await renderDetail({ facade });

    const section = await sourcesSection();
    fireEvent.click(await section.findByRole("button", { name: "关联更新来源" }));
    fireEvent.change(await screen.findByLabelText("来源地址"), {
      target: { value: "https://example.com/org/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认关联" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "关联网络更新来源" })).toBeVisible();
  });

  it("renders the upstream lineage from summary facts and never sample names", async () => {
    await renderDetail();

    expect(await screen.findByText("无复用修改依据。此技能不是从其他 Skill 复用修改创建的。")).toBeVisible();
    expect(screen.queryByText(/PDF Reader 基础版/)).not.toBeInTheDocument();
  });

  it("links to the upstream skill when the lineage resolves a display name", async () => {
    const facade = createMockSkillDetailFacade({
      summary: {
        upstreamLineage: {
          source_skill_id: "skill-doc",
          source_version_id: "version-100",
          source_display_name: "DOCX Writer",
          created_at: null,
        },
      },
    });
    await renderDetail({ facade });

    const lineageLink = await screen.findByRole("link", { name: /DOCX Writer/ });
    expect(lineageLink).toHaveAttribute("href", "/library/skill-doc");
  });

  it("keeps no DEV demo buttons in the source updates section", async () => {
    await renderDetail();
    await screen.findByRole("heading", { name: "PDF Reader" });

    const section = await sourcesSection();
    for (const label of ["模拟未关联", "模拟已关联", "模拟本地有修改", "模拟检查失败", "模拟查找失败", "切换复用修改追溯"]) {
      expect(section.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    expect(section.queryByText("DEV 场景演示")).not.toBeInTheDocument();
  });

  it("renders the import record from real provenance fields", async () => {
    await renderDetail();

    // 同一原始路径也会出现在已观察部署等真实区块中；导入记录断言限定其容器。
    const importRecord = await waitFor(() => {
      const el = document.querySelector(".sh-skill-detail-review__import-record");
      if (!el) throw new Error("import record block not mounted yet");
      return within(el as HTMLElement);
    });
    // 原始位置与来源记录夹具值相同，两条 dd 各渲染一次。
    const pathEntries = await importRecord.findAllByText("C:/Users/demo/.agents/skills/pdf-reader");
    expect(pathEntries.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("~/Agents/Codex/skills/pdf-reader")).not.toBeInTheDocument();
  });
});

// W3-6：主体位置展示 K9 真实物化根路径（summary.rootPath），打开走受控
// open_local_directory 命令（注入 DirectoryOpener），复制走剪贴板；样例
// 路径与「打开位置确认弹层」不再存在。
describe("SkillDetailPage subject location (W3-6)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("opens the real subject location through the controlled opener", async () => {
    const openDirectory = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
    const facade = createMockSkillDetailFacade({ summary: { rootPath: "C:/SkillHub/skills/pdf-reader" } });
    await renderDetail({ directoryOpener: { openDirectory }, facade });

    fireEvent.click(await screen.findByRole("button", { name: "打开位置" }));

    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith("C:/SkillHub/skills/pdf-reader"));
    expect(screen.queryByText("~/SkillHub/skills/pdf-reader")).not.toBeInTheDocument();
  });

  it("keeps a readable error when the open command fails", async () => {
    const openDirectory = vi.fn<(path: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
    const facade = createMockSkillDetailFacade({ summary: { rootPath: "C:/SkillHub/skills/pdf-reader" } });
    await renderDetail({ directoryOpener: { openDirectory }, facade });

    fireEvent.click(await screen.findByRole("button", { name: "打开位置" }));

    expect(await screen.findByRole("alert")).toBeVisible();
  });

  it("copies the real subject location path to the clipboard", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const facade = createMockSkillDetailFacade({ summary: { rootPath: "C:/SkillHub/skills/pdf-reader" } });
    await renderDetail({ facade });

    fireEvent.click(await screen.findByRole("button", { name: "复制路径" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("C:/SkillHub/skills/pdf-reader"));
    expect(await screen.findByText("路径已复制。")).toBeVisible();
  });

  it("shows an honest empty state when the root is not materialized", async () => {
    await renderDetail();

    expect(await screen.findByText("主体目录未物化或未知。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "打开位置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制路径" })).not.toBeInTheDocument();
    expect(screen.queryByText("~/SkillHub/skills/pdf-reader")).not.toBeInTheDocument();
  });
});

// W3-7：概览生命周期与组合接真实事实——复核日期与转常规走 setTrial 命令，
// 组合行显示 insights 组合事实并链接组合管理页；DEV 场景按钮与样例保存
// 文案移除。
describe("SkillDetailPage lifecycle and combinations (W3-7)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("saves the trial review date through the real setTrial command", async () => {
    const facade = createMockSkillDetailFacade({ summary: { lifecycle: "trial", trialDue: "2026-11-03" } });
    await renderDetail({ facade });

    fireEvent.click(await screen.findByRole("button", { name: "调整复核日期" }));
    fireEvent.change(await screen.findByLabelText("复核日期"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "保存复核日期" }));

    await waitFor(() => expect(facade.calls.trials).toEqual([{ skillId: "skill-pdf", due: "2026-12-01" }]));
    expect(screen.queryByText("试用复核设置")).not.toBeInTheDocument();
    expect(screen.queryByText("切换到试用复核场景")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("returns a trial skill to regular through the review dialog", async () => {
    const facade = createMockSkillDetailFacade({ summary: { lifecycle: "trial", trialDue: "2026-11-03" } });
    await renderDetail({ facade });

    fireEvent.click(await screen.findByRole("button", { name: "调整复核日期" }));
    fireEvent.click(await screen.findByRole("button", { name: "转为常规" }));

    await waitFor(() => expect(facade.calls.trials).toEqual([{ skillId: "skill-pdf", due: null }]));
    expect(await screen.findAllByText("常规").then((nodes) => nodes.length)).toBeGreaterThan(0);
  });

  it("shows real combination facts and links to the combination manager", async () => {
    await renderDetail();

    expect(await screen.findByText("Document toolkit")).toBeVisible();
    expect(screen.getByRole("link", { name: "管理组合" })).toHaveAttribute("href", "/library/combinations");
    expect(screen.queryByText("组合成员变更已保存到当前原型示例。")).not.toBeInTheDocument();
  });
});

// W3-8：评审使用区 AI 相似性接真实契约——SemanticDuplicatePanel 常显
// insights 确定性候选，可选 AI 层按 isAiAvailable 三态降级（未配置→停用
// 按钮+如实文案；已配置→真实 analyzeSemanticDuplicates；失败→可读原因）。
// DEV 演示开关与模拟结果文本移除。
describe("SkillDetailPage AI usage insights (W3-8)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("runs the real AI similarity analysis from the review usage section", async () => {
    const facade = createMockSkillDetailFacade();
    await renderDetail({ facade });

    expect(await screen.findByText("Deterministic duplicate candidates")).toBeVisible();
    expect(screen.getByText("PDF Reader（副本）")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run analysis" }));
    expect(await screen.findByText("PDF Text Extractor")).toBeVisible();
    expect(facade.calls.analyzedDuplicateSkills).toEqual(["skill-pdf"]);
    expect(screen.queryByText("模拟 AI 已配置")).not.toBeInTheDocument();
    expect(screen.queryByText("DEV 演示：只影响本区")).not.toBeInTheDocument();
    expect(screen.queryByText("PDF Text Extractor · 内容比对候选，尚未确认重复。")).not.toBeInTheDocument();
  });

  it("keeps deterministic candidates usable when no AI provider is configured", async () => {
    const facade = createMockSkillDetailFacade({ aiAvailable: false });
    await renderDetail({ facade });

    const run = await screen.findByRole("button", { name: "Run analysis" });
    expect(run).toBeDisabled();
    expect(
      screen.getByText(
        "No usable LLM provider is configured; AI actions are disabled and deterministic candidates remain available.",
      ),
    ).toBeVisible();
    expect(screen.getByText("PDF Reader（副本）")).toBeVisible();
    expect(facade.calls.analyzedDuplicateSkills).toEqual([]);
  });
});
