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
} from "../../api/bindings";
import type { RelationGovernanceFacade } from "../relationships/governance/api";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { separateCheckFixture, type SecurityFacade } from "../security/api";
import type { SkillLibraryFacade, SkillLibraryQuery, SkillTableRow } from "../skills/api";
import { MOCK_SKILL_BROWSER, MOCK_SKILL_DOCX, MOCK_SKILL_PDF } from "../skills/testFixtures";

interface RenderDetailOptions {
  entry?: InitialEntry;
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
              element={<SkillDetailPage facade={facade} governanceFacade={governanceFacade} libraryFacade={libraryFacade} markdownFacade={markdownFacade} removalFacade={removalFacade} securityFacade={securityFacade} tracker={tracker} />}
              path="/library/:skillId"
            />
            <Route
              element={<SkillDetailPage facade={facade} governanceFacade={governanceFacade} libraryFacade={libraryFacade} markdownFacade={markdownFacade} removalFacade={removalFacade} securityFacade={securityFacade} tracker={tracker} />}
              path="/__preview/skill-detail/:skillId"
            />
            <Route element={<p>Library route</p>} path="/library" />
            <Route element={<SecurityProbe />} path="/library/:skillId/security" />
            <Route element={<DeploymentProbe />} path="/library/:skillId/deploy" />
            <Route element={<ExportProbe />} path="/settings/data-protection" />
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
}): RelationGovernanceRow {
  const sharedImpactOnly = spec.sharedImpactOnly === true;
  return {
    relation: {
      kind: "deployment",
      fact: governanceDeploymentFact({
        relation_id: spec.relationId,
        relationship: sharedImpactOnly ? "observed_copy" : "managed_copy",
        ownership: sharedImpactOnly ? "observed_unmanaged" : "skillhub_managed",
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
      governance_status: "pending",
      management_status: "not_taken_over",
      decision: "undecided",
      management_confirmed_at: null,
      health_reasons: sharedImpactOnly ? ["shared_impact_confirmation_required"] : [],
      action_conditions: [{
        action: "centralize_management",
        available: !sharedImpactOnly,
        reasons: sharedImpactOnly ? ["shared_impact_confirmation_required"] : [],
      }],
    },
    target_identity: null,
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
      name: "Bring the selection under central library management",
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
      name: "Bring the selection under central library management",
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
