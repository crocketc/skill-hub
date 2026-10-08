import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type InitialEntry } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DeploymentRelationFact,
  RelationGovernanceBatchItem,
  RelationGovernanceBatchOutcome,
  RelationGovernanceLedger,
  RelationGovernanceRow,
  RemovalImpactFact,
  RemovalResult,
  RelationshipCheckReport,
  SourceCopyRelationFact,
} from "../../../api/bindings";
import { createOperationTracker, type OperationTracker } from "../../../platform/operationTracker";
import { createSkillHubI18n } from "../../../i18n";
import { AppNotificationsProvider } from "../../../ui/notifications";
import { RelationshipsGovernancePage } from "../RelationshipsPages";
import {
  RelationshipGovernancePage,
  type RelationGovernanceFacade,
} from "./RelationshipGovernancePage";

vi.mock("./nativeApi", () => ({ nativeGovernanceFacade: { __mocked: true } }));

afterEach(() => {
  // 先卸载：页面在 cleanup effect 里回写 return-state，必须发生在
  // sessionStorage 清空之前，否则上一用例的勾选会泄漏进下一用例。
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function relationFact(overrides: Partial<DeploymentRelationFact> = {}): DeploymentRelationFact {
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

function deploymentFactOf(row: RelationGovernanceRow): DeploymentRelationFact {
  if (row.relation.kind !== "deployment") {
    throw new Error("expected a deployment relation in this test fixture");
  }
  return row.relation.fact;
}

interface RowSpec {
  relationId: string;
  status?: RelationGovernanceRow["status"];
  readiness: RelationGovernanceRow["readiness"];
  primaryAction: RelationGovernanceRow["primary_action"];
  blockers?: RelationGovernanceRow["blockers"];
  relationship?: DeploymentRelationFact["relationship"];
  ownership?: DeploymentRelationFact["ownership"];
  agentClientId?: string;
  path?: string;
  skillId?: string | null;
  displayName?: string | null;
  otherConsumers?: string[];
  governance?: RelationGovernanceRow["governance"];
}

function governanceFromRowSpec(spec: RowSpec): RelationGovernanceRow["governance"] {
  const healthReasons: RelationGovernanceRow["governance"]["health_reasons"] = [];
  if (spec.blockers?.includes("verification_not_current")) healthReasons.push("verification_required");
  if (spec.blockers?.includes("shared_impact_confirmation_required")) healthReasons.push("shared_impact_confirmation_required");
  if (spec.blockers?.includes("unverifiable_representation")) healthReasons.push("relationship_not_convertible");
  const action_conditions: RelationGovernanceRow["governance"]["action_conditions"] = [];
  if (spec.primaryAction === "centralize_management") {
    action_conditions.push({ action: "centralize_management", available: spec.readiness === "eligible_to_centralize", reasons: healthReasons });
  } else if (spec.blockers?.length || spec.readiness !== "already_centralized") {
    action_conditions.push({
      action: "centralize_management",
      available: false,
      reasons: healthReasons.length > 0 ? healthReasons : ["relationship_not_convertible"],
    });
  }
  if (spec.primaryAction === "revalidate" || spec.readiness === "eligible_to_centralize") {
    action_conditions.push({ action: "revalidate", available: true, reasons: [] });
  }
  if (spec.primaryAction === "undeploy") action_conditions.push({ action: "undeploy", available: true, reasons: [] });
  return {
    governance_status: spec.primaryAction === "undeploy" ? "completed" : "pending",
    management_status: spec.primaryAction === "undeploy" ? "taken_over" : "not_taken_over",
    decision: "undecided",
    management_confirmed_at: null,
    health_reasons: healthReasons,
    action_conditions,
  };
}

function makeRow(spec: RowSpec): RelationGovernanceRow {
  return {
    relation: {
      kind: "deployment" as const,
      fact: relationFact({
        relation_id: spec.relationId,
        skill_id: spec.skillId === undefined ? "skill-pdf" : spec.skillId,
        agent_client_id: spec.agentClientId ?? "codex",
        path: spec.path ?? "C:/agents/codex/skills/pdf-reader",
        relationship: spec.relationship ?? "managed_copy",
        ownership: spec.ownership ?? "skillhub_managed",
      }),
    },
    skill_display_name: spec.displayName ?? null,
    status: spec.status ?? (spec.readiness === "blocked" ? "blocked" : "needs_validation"),
    readiness: spec.readiness,
    primary_action: spec.primaryAction,
    blockers: spec.blockers ?? [],
    impact: {
      other_consumer_agent_ids: spec.otherConsumers ?? [],
      other_skill_paths: [],
      backup_required: true,
      rollback_available: true,
    },
    governance: spec.governance ?? governanceFromRowSpec(spec),
    target_identity: null,
    source_read_only: false,
    evidence_relation_ids: [spec.relationId],
  };
}

const ELIGIBLE_ROW = makeRow({
  relationId: "managed:dep-eligible",
  readiness: "eligible_to_centralize",
  primaryAction: "centralize_management",
  displayName: "PDF 阅读器",
});

const SHARED_IMPACT_ROW = makeRow({
  relationId: "managed:dep-shared",
  readiness: "needs_validation",
  primaryAction: "revalidate",
  blockers: ["shared_impact_confirmation_required"],
  displayName: "共享 PDF",
  otherConsumers: ["cursor"],
});

const STALE_VERIFICATION_ROW = makeRow({
  relationId: "observed:agent.codex:notes",
  readiness: "needs_validation",
  primaryAction: "revalidate",
  blockers: ["verification_not_current"],
  relationship: "observed_copy",
  ownership: "observed_unmanaged",
  path: "C:/agents/codex/skills/notes",
});

const BLOCKED_ROW = makeRow({
  relationId: "observed:agent.codex:broken",
  readiness: "blocked",
  primaryAction: "none",
  blockers: ["unverifiable_representation"],
  relationship: "shared_directory_read",
  path: "C:/agents/codex/skills/broken",
});

const MANAGED_ROW = makeRow({
  relationId: "managed:dep-undeploy",
  readiness: "already_centralized",
  primaryAction: "undeploy",
  relationship: "managed_link",
  path: "C:/agents/codex/skills/link-reader",
});

/** K2/G-07：可执行「从 Agent/项目移除」且需要共享影响显式确认的部署边。 */
const SHARED_UNDEPLOY_ROW = makeRow({
  relationId: "managed:dep-shared-undeploy",
  readiness: "needs_validation",
  primaryAction: "undeploy",
  blockers: ["shared_impact_confirmation_required"],
  displayName: "共享移除 PDF",
  path: "C:/agents/codex/skills/shared-reader",
});

/** 共享目标移除行的独立台账：不影响 FULL_LEDGER 的计数断言。 */
function sharedUndeployLedger(): RelationGovernanceLedger {
  return {
    rows: [SHARED_UNDEPLOY_ROW],
    counts: {
      all: 1,
      eligible_to_centralize: 0,
      needs_validation: 1,
      blocked: 0,
      status_normal: 0,
      status_retained: 0,
      status_needs_validation: 1,
      status_needs_attention: 0,
      status_blocked: 0,
      source_copies: 0,
      deployments: 1,
    },
    bucket: "all",
    total: 1,
    relationship_revision: "rev-1",
    last_verified_at: "2026-09-17T08:00:00Z",
  };
}

const FULL_LEDGER: RelationGovernanceLedger = {
  rows: [ELIGIBLE_ROW, SHARED_IMPACT_ROW, STALE_VERIFICATION_ROW, BLOCKED_ROW, MANAGED_ROW],
  counts: {
    all: 5,
    eligible_to_centralize: 1,
    needs_validation: 2,
    blocked: 1,
    status_normal: 0,
    status_retained: 0,
    status_needs_validation: 2,
    status_needs_attention: 1,
    status_blocked: 1,
    source_copies: 0,
    deployments: 5,
  },
  bucket: "all",
  total: 5,
  relationship_revision: "rev-1",
  last_verified_at: "2026-09-17T08:00:00Z",
};

function removalImpactFact(): RemovalImpactFact {
  return {
    relation_id: deploymentFactOf(ELIGIBLE_ROW).relation_id,
    relation: deploymentFactOf(ELIGIBLE_ROW),
    ownership: "skillhub_managed",
    current_agent_reads_shared_directory: false,
    other_consumers: [],
    other_skill_paths: [],
    minimal_action: "convert_copy_to_managed_link",
    backup: {
      backup_location: "C:/library/.skillhub/backups/b-1",
      detail: "relationship-migration backup",
      required: true,
      rollback_available: true,
    },
    governance_tasks: [],
    permission_limited: false,
  };
}

function batchItem(overrides: Partial<RelationGovernanceBatchItem> = {}): RelationGovernanceBatchItem {
  return {
    relation_id: deploymentFactOf(ELIGIBLE_ROW).relation_id,
    operation_id: "op-child-1",
    state: "prepared",
    error_code: null,
    detail: null,
    retryable: true,
    rollback_available: true,
    backup_path: "C:/library/.skillhub/relationship-migrations/op-child-1/previous",
    affected_paths: ["C:/agents/codex/skills/pdf-reader"],
    blockers: [],
    ...overrides,
  };
}

function batchOutcome(overrides: Partial<RelationGovernanceBatchOutcome> = {}): RelationGovernanceBatchOutcome {
  return {
    batch_id: "batch-1",
    action: "centralize_management",
    state: "prepared",
    items: [batchItem()],
    prepared_count: 1,
    committed_count: 0,
    failed_count: 0,
    blocked_count: 0,
    cancelled_count: 0,
    relationship_revision: "rev-2",
    ...overrides,
  };
}

function undeployResult(): RemovalResult {
  return {
    operation_id: "op-undeploy-1",
    skill_id: "skill-pdf",
    decisions: [
      {
        deployment_id: "dep-undeploy",
        decision: "remove_owned_target",
        target_removed: true,
        relation_removed: true,
        management_detached: true,
      },
    ],
    central_skill_deleted: false,
  };
}

function createFacade(
  ledger: RelationGovernanceLedger = FULL_LEDGER,
  overrides: Partial<RelationGovernanceFacade> = {},
): RelationGovernanceFacade {
  return {
    listGovernance: vi.fn().mockResolvedValue(ledger),
    revalidate: vi.fn().mockResolvedValue(undefined),
    listHistory: vi.fn().mockResolvedValue(undefined),
    retainSourceCopy: vi.fn().mockResolvedValue(undefined),
    revokeRetention: vi.fn().mockResolvedValue({ relation_id: "source-1", relationship_revision: "rev-2", replayed: false }),
    endRelationship: vi.fn().mockResolvedValue({ relation_id: "source-1", relationship_revision: "rev-2", replayed: false }),
    relinkSourceCopy: vi.fn().mockResolvedValue(undefined),
    getRelationshipRemovalImpact: vi.fn().mockResolvedValue(removalImpactFact()),
    prepareGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome()),
    commitGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
      state: "committed",
      items: [batchItem({ state: "committed" })],
      prepared_count: 1,
      committed_count: 1,
    })),
    rollbackGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
      state: "committed",
      items: [batchItem({ state: "rolled_back" })],
    })),
    prepareRelationUndeploy: vi.fn().mockResolvedValue({
      relationId: deploymentFactOf(MANAGED_ROW).relation_id,
      deploymentId: "dep-undeploy",
      operationId: "op-undeploy-1",
    }),
    commitRelationUndeploy: vi.fn().mockResolvedValue(undeployResult()),
    ...overrides,
  };
}

function HistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <p data-testid="location-key">{location.key}</p>
      <p data-testid="location-path">{location.pathname}</p>
      <p data-testid="location-search">{location.search}</p>
      <p data-testid="location-state">{JSON.stringify(location.state)}</p>
      <button data-testid="nav-depart" onClick={() => navigate("/operations/op-1")}>depart</button>
      <button data-testid="nav-back" onClick={() => navigate(-1)}>back</button>
    </div>
  );
}

interface RenderOptions {
  entries?: InitialEntry[];
  initialIndex?: number;
  locale?: "en-US" | "zh-CN";
  facade?: RelationGovernanceFacade;
  tracker?: OperationTracker;
  /** 包上 AppNotificationsProvider：桥接失败通知只有在真实通知服务下才会发出。 */
  notifications?: boolean;
}

interface RenderedContext {
  facade: RelationGovernanceFacade;
  tracker: OperationTracker;
  unmount: () => void;
}

async function renderGovernanceApp(options: RenderOptions = {}): Promise<RenderedContext> {
  const i18n = await createSkillHubI18n([options.locale ?? "zh-CN"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const {
    entries = ["/relationships/governance"],
    initialIndex = 0,
    facade = createFacade(),
    tracker = createOperationTracker(),
    notifications = false,
  } = options;
  const routes = (
    <>
      <Routes>
        <Route
          element={<RelationshipGovernancePage facade={facade} tracker={tracker} />}
          path="/relationships/governance"
        />
        <Route element={<p>OPERATION_PAGE</p>} path="/operations/:operationId" />
        <Route element={<p>AGENT_ORIGIN</p>} path="/agents/:agentKey" />
        <Route element={<p>LIBRARY_ORIGIN</p>} path="/library" />
        <Route element={<p data-testid="skill-detail-origin">SKILL_DETAIL_ORIGIN</p>} path="/library/:skillId" />
        <Route element={<p>PROJECT_ORIGIN</p>} path="/projects/:projectKey" />
        <Route element={<p>GRAPH_ORIGIN</p>} path="/relationships" />
        <Route element={<p>DECISIONS_ORIGIN</p>} path="/relationships/decisions" />
        <Route element={<p>DEPLOY_PAGE</p>} path="/deploy" />
      </Routes>
      <HistoryProbe />
    </>
  );
  // 通知 provider 必须在 Router 内：操作深链 toast 里的 <Link> 依赖路由上下文。
  const tree = (
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      {notifications ? <AppNotificationsProvider>{routes}</AppNotificationsProvider> : routes}
    </MemoryRouter>
  );
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        {tree}
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { facade, tracker, unmount: rendered.unmount };
}

async function waitRows() {
  await screen.findByTestId("governance-row-list");
  await screen.findByText("PDF 阅读器");
}

function rowCheckbox(relationId: string): HTMLInputElement {
  return screen.getByTestId(`governance-select-${relationId}`) as HTMLInputElement;
}

function rowAction(relationId: string): HTMLButtonElement {
  return screen.getByTestId(`governance-action-${relationId}`) as HTMLButtonElement;
}

function openRelationDetails(relationId: string) {
  const source = screen.getByTestId(`governance-source-${relationId}`);
  const details = source.closest("details");
  if (!details) throw new Error("expected relationship facts to be in a details disclosure");
  fireEvent.click(within(details).getByText("查看关系信息"));
  return details;
}

describe("RelationshipGovernancePage 清单（按关系边渲染）", () => {
  it("opens in two authoritative governance columns with one relationship edge per card", async () => {
    await renderGovernanceApp({ entries: ["/relationships/governance?governance=all"] });
    await waitRows();

    // 五条关系边各一张卡；即使多条边属于同一个 Skill 也不按 Skill 合并。
    expect(screen.getAllByTestId("governance-row")).toHaveLength(5);
    expect(screen.getByText("PDF 阅读器")).toBeVisible();
    openRelationDetails("managed:dep-undeploy");
    expect(screen.getByText("C:\\agents\\codex\\skills\\link-reader")).toBeVisible();

    expect(screen.getByTestId("governance-board").querySelectorAll(":scope > section")).toHaveLength(2);
    expect(screen.getByTestId("governance-board-column-pending")).toHaveTextContent("待处理");
    expect(screen.getByTestId("governance-board-column-completed")).toHaveTextContent("已完成");
    expect(screen.getByTestId("governance-board").firstElementChild).toBe(screen.getByTestId("governance-board-column-pending"));
    expect(screen.getByTestId("governance-source-managed:dep-eligible")).toHaveTextContent("导入登记");
    expect(screen.getByTestId("governance-target-managed:dep-eligible")).toHaveTextContent("Codex");
    // 影响列展示其他共享消费者。
    expect(screen.getByTestId("governance-impact-managed:dep-shared")).toHaveTextContent("Cursor");
  });

  it("summarizes deep-linked hidden filters without exposing any filter chips", async () => {
    const retainedSource = makeSourceRow({
      relationId: "src-retained-summary",
      decision: "retained",
      health: "normal",
      status: "retained",
      readiness: "already_centralized",
      primaryAction: "none",
    });
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=completed&scope=source_copy&management=not_taken_over"],
      facade: createFacade({ ...FULL_LEDGER, rows: [retainedSource], total: 1 }),
    });
    await screen.findByTestId("governance-row-list");

    // 旧深链继续可用：页签映射 + 隐藏行过滤，但筛选条里没有任何 chips。
    expect(screen.getAllByTestId("governance-row")).toHaveLength(1);
    expect(screen.getByTestId("governance-bucket-completed")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("governance-filter-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-scope-source_copy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-management-not_taken_over")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-clear-secondary-filters")).not.toBeInTheDocument();
  });

  it("keeps card details compact while leaving blockers and actions immediately available", async () => {
    const blocked = makeRow({
      relationId: "blocked-compact-card",
      readiness: "blocked",
      primaryAction: "none",
      blockers: ["unverifiable_representation"],
      displayName: "受阻关系",
    });
    await renderGovernanceApp({
      facade: createFacade({ ...FULL_LEDGER, rows: [blocked], total: 1 }),
    });
    await screen.findByTestId("governance-row-list");

    const card = screen.getByTestId("governance-row");
    const details = within(card).getByTestId("governance-relation-details");
    expect(details).not.toHaveAttribute("open");
    expect(within(card).getByText("此关系类型暂不支持纳入技能库管理。")).toBeVisible();
    expect(within(card).queryByTestId("governance-action-blocked-compact-card")).not.toBeInTheDocument();
    expect(within(details).getByText("C:\\agents\\codex\\skills\\pdf-reader")).toBeInTheDocument();
    fireEvent.click(within(details).getByText("查看关系信息"));
    expect(details).toHaveAttribute("open");
  });

  it("switches between board and table without losing selection or URL filters", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?from=agent&agent=codex"],
    });
    await waitRows();

    fireEvent.click(rowCheckbox("managed:dep-eligible"));
    fireEvent.click(screen.getByRole("button", { name: "切换到表格视图" }));
    expect(screen.getByTestId("governance-header-relation")).toHaveTextContent("关系");
    expect(rowCheckbox("managed:dep-eligible").checked).toBe(true);
    expect(screen.getByTestId("location-search")).toHaveTextContent("?from=agent&agent=codex&view=table");

    fireEvent.click(screen.getByRole("button", { name: "切换到看板视图" }));
    expect(screen.getByTestId("governance-board-column-pending")).toBeVisible();
    expect(rowCheckbox("managed:dep-eligible").checked).toBe(true);
  });

  it("uses a readable fallback name instead of exposing internal identifiers", async () => {
    const unnamed = makeRow({
      relationId: "internal-relation-731",
      readiness: "eligible_to_centralize",
      primaryAction: "centralize_management",
      skillId: "internal-skill-284",
      displayName: null,
    });
    await renderGovernanceApp({
      facade: createFacade({
        ...FULL_LEDGER,
        rows: [unnamed],
        counts: { ...FULL_LEDGER.counts, all: 1 },
        total: 1,
      }),
    });
    await screen.findByTestId("governance-select-internal-relation-731");

    expect(screen.getByText("未命名技能")).toBeVisible();
    expect(screen.getByLabelText("选择关系 未命名技能")).toBeVisible();
    expect(document.body).not.toHaveTextContent("internal-skill-284");
    expect(document.body).not.toHaveTextContent("internal-relation-731");
  });

  it("shows all, pending and completed counts from the authoritative projection", async () => {
    await renderGovernanceApp();
    await waitRows();

    expect(screen.getByRole("button", { name: "全部（5）" })).toBeVisible();
    expect(screen.getByRole("button", { name: "待处理（4）" })).toBeVisible();
    expect(screen.getByRole("button", { name: "已完成（1）" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "已完成（1）" }));
    expect(await screen.findAllByTestId("governance-row")).toHaveLength(1);
    expect(screen.getByTestId("location-search")).toHaveTextContent("governance=completed");
  });

  it("explains blockers on blocked rows instead of offering an action", async () => {
    await renderGovernanceApp();
    await waitRows();

    const blockedCell = screen.getByTestId("governance-reasons-observed:agent.codex:broken");
    expect(blockedCell).toHaveTextContent("此关系类型暂不支持纳入技能库管理");
    expect(screen.queryByTestId("governance-action-observed:agent.codex:broken")).not.toBeInTheDocument();
    expect(rowCheckbox("observed:agent.codex:broken")).toBeDisabled();
  });

  it("applies the search text to the ledger query", async () => {
    const { facade } = await renderGovernanceApp();
    await waitRows();

    const input = screen.getByLabelText("搜索 Skill、目标或路径");
    fireEvent.change(input, { target: { value: "notes" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ text: "notes" }),
    ));
  });

  it("keeps the normal add shortcut clearly separate from governance execution", async () => {
    await renderGovernanceApp({ entries: ["/relationships/governance?governance=all"] });
    await waitRows();

    const deployEntry = screen.getByTestId("governance-deploy-entry");
    const deployLink = deployEntry.querySelector("a");
    expect(deployLink).not.toBeNull();
    expect(deployLink?.getAttribute("href")).toBe("/deploy");
    expect(deployLink?.textContent).toContain("添加到 Agent/项目");
    // 治理行上的主操作不是「添加到 Agent/项目」：动作词互不混用。
    expect(rowAction("managed:dep-eligible").textContent).toContain("纳入技能库管理");
    expect(rowAction("managed:dep-undeploy").textContent).toContain("从 Agent/项目移除");
  });

  it("keeps the workbench as the single canvas child of the relationships grid", async () => {
    // 布局契约回归：.sh-relationships 是两行网格（页签 + 画布）；
    // 治理页的块级子元素一旦直接散落在网格里，画布行会被压缩，
    // 内容整体叠到后续兄弟元素上（2026-09-25 验收缺陷）。
    await renderGovernanceApp();
    await waitRows();

    const grid = document.querySelector(".sh-relationships");
    expect(grid).not.toBeNull();
    expect(grid!.children).toHaveLength(2);
    expect(grid!.children[0].className).toContain("sh-relationships__nav");
    expect(grid!.children[1].className).toContain("sh-governance");
    expect(grid!.children[1].className).not.toContain("sh-governance__");
  });
});

// —— FB-④（§10，2026-10-06）：页签默认待处理、细分桶、整桶勾选、筛选条内联 ——

const COMPLETED_EXTRA_A = makeRow({
  relationId: "managed:dep-extra-a",
  readiness: "already_centralized",
  primaryAction: "undeploy",
  relationship: "managed_link",
  path: "C:/agents/codex/skills/extra-a",
});

const COMPLETED_EXTRA_B = makeRow({
  relationId: "managed:dep-extra-b",
  readiness: "already_centralized",
  primaryAction: "undeploy",
  relationship: "managed_link",
  path: "C:/agents/codex/skills/extra-b",
});

describe("RelationshipGovernancePage 页签与细分桶（FB-④）", () => {
  it("opens on the pending tab by default and renders only pending rows", async () => {
    await renderGovernanceApp();
    await waitRows();

    expect(screen.getByTestId("governance-bucket-pending")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("governance-row")).toHaveLength(4);
    expect(screen.queryByText("link-reader")).not.toBeInTheDocument();
  });

  it("orders the tabs 待处理 → 已完成 → 全部 and keeps counts as the only statistics", async () => {
    await renderGovernanceApp({ entries: ["/relationships/governance?governance=all"] });
    await waitRows();

    const tabs = within(screen.getByTestId("governance-buckets")).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["待处理（4）", "已完成（1）", "全部（5）"]);
    // 双口径注脚已删除：页签与桶头计数是唯一统计口径。
    expect(screen.queryByTestId("governance-count-scope")).not.toBeInTheDocument();
  });

  it("keeps the 全部 board in fixed order with pending on the left regardless of counts", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade: createFacade({
        ...FULL_LEDGER,
        rows: [ELIGIBLE_ROW, MANAGED_ROW, COMPLETED_EXTRA_A, COMPLETED_EXTRA_B],
        total: 4,
      }),
    });
    await waitRows();

    const board = screen.getByTestId("governance-board");
    const columns = board.querySelectorAll(":scope > section");
    expect(columns).toHaveLength(2);
    // 列序固定：待处理在左、已完成在右，不随数量互换位置。
    expect(columns[0]).toHaveAttribute("data-testid", "governance-board-column-pending");
    expect(columns[1]).toHaveAttribute("data-testid", "governance-board-column-completed");
  });

  it("splits the pending tab into category buckets, hides empty ones and explains restricted rows", async () => {
    await renderGovernanceApp();
    await waitRows();

    // 四条待处理行各归其桶：尚未作决定 / 待重新核验 / 权限受限。
    const undecided = screen.getByTestId("governance-bucket-undecided");
    expect(undecided).toHaveTextContent("尚未作决定");
    expect(within(undecided).getAllByTestId("governance-row")).toHaveLength(1);
    expect(screen.getByTestId("governance-bucket-undecided-count")).toHaveTextContent("1");
    expect(screen.getByTestId("governance-bucket-needs_review")).toHaveTextContent("待重新核验");
    const restricted = screen.getByTestId("governance-bucket-restricted");
    expect(restricted).toHaveTextContent("权限受限");
    expect(within(restricted).getAllByTestId("governance-row")).toHaveLength(2);
    // 权限受限桶给「原因 + 如何解除 + 重新核验」说明。
    expect(screen.getByTestId("governance-bucket-restricted-note")).toHaveTextContent("按各条原因处理");
    // 空桶隐藏。
    expect(screen.queryByTestId("governance-bucket-content_changed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-bucket-source_missing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-bucket-link_issue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-bucket-operation_failed")).not.toBeInTheDocument();
  });

  it("splits the completed tab into managed links and retained copies", async () => {
    const retained = makeSourceRow({
      relationId: "src-retained-tab",
      decision: "retained",
      health: "normal",
      status: "retained",
      readiness: "already_centralized",
      primaryAction: "none",
    });
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=completed"],
      facade: createFacade(sourceLedger([retained, MANAGED_ROW])),
    });
    await screen.findByTestId("governance-row-list");

    const managed = screen.getByTestId("governance-bucket-managed_link");
    expect(managed).toHaveTextContent("正常受管链接");
    expect(within(managed).getAllByTestId("governance-row")).toHaveLength(1);
    const retainedBucket = screen.getByTestId("governance-bucket-retained");
    expect(retainedBucket).toHaveTextContent("已保留独立拷贝");
    expect(within(retainedBucket).getAllByTestId("governance-row")).toHaveLength(1);
  });

  it("lets a whole bucket be checked for its batch action without touching other buckets", async () => {
    await renderGovernanceApp();
    await waitRows();

    const bucketSelect = screen.getByTestId("governance-bucket-select-undecided") as HTMLInputElement;
    fireEvent.click(bucketSelect);
    expect(rowCheckbox("managed:dep-eligible").checked).toBe(true);
    expect(rowCheckbox("observed:agent.codex:notes").checked).toBe(false);

    fireEvent.click(bucketSelect);
    expect(rowCheckbox("managed:dep-eligible").checked).toBe(false);

    // 权限受限桶里仅差共享确认的行仍可整桶选中，受阻行保持未选。
    fireEvent.click(screen.getByTestId("governance-bucket-select-restricted"));
    expect(rowCheckbox("managed:dep-shared").checked).toBe(true);
    expect(rowCheckbox("observed:agent.codex:broken").checked).toBe(false);
  });

  it("keeps the filter bar inline with search and view switch only", async () => {
    await renderGovernanceApp();
    await waitRows();

    expect(screen.queryByTestId("governance-filter-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-filter-popover")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeVisible();
    expect(screen.getByRole("button", { name: "切换到表格视图" })).toBeVisible();
  });

  it("maps a management deep link to its tab and keeps filtering rows", async () => {
    const ledger: RelationGovernanceLedger = {
      ...FULL_LEDGER,
      rows: [SOURCE_ROW, ELIGIBLE_ROW, MANAGED_ROW],
      total: 3,
    };
    await renderGovernanceApp({
      entries: ["/relationships/governance?management=taken_over"],
      facade: createFacade(ledger),
    });
    await screen.findByTestId("governance-row-list");

    // 旧管理状态深链映射到对应页签，行过滤继续生效。
    expect(screen.getByTestId("governance-bucket-completed")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("governance-row")).toHaveLength(1);

    // 管理状态行过滤在页签切换后仍然生效：待集中管理行不在已完成桶里。
    fireEvent.click(screen.getByTestId("governance-bucket-pending"));
    expect(await screen.findByRole("status")).toHaveTextContent("该筛选下没有关系");
  });
});

// —— FB-④/D8（§10，2026-10-06）：只读导入原件是权限边界内的正常终态；
// 待处理清空后给鼓励空态。 ——

const READ_ONLY_ORIGINAL_ROW = makeSourceRow({
  relationId: "src-readonly-original",
  displayName: "只读原件 PDF",
  decision: "retained",
  health: "normal",
  status: "retained",
  readiness: "blocked",
  primaryAction: "none",
  sourceReadOnly: true,
});

describe("RelationshipGovernancePage 只读导入原件与鼓励空态（FB-④/D8）", () => {
  it("renders the read-only original as a terminal card without actions, selection or blockers", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=completed"],
      facade: createFacade(sourceLedger([READ_ONLY_ORIGINAL_ROW, RETAINED_SOURCE_ROW])),
    });
    await screen.findByTestId("governance-row-list");

    const retainedBucket = screen.getByTestId("governance-bucket-retained");
    const readonlyCard = retainedBucket.querySelector('[data-readonly="true"]') as HTMLElement;
    expect(readonlyCard).not.toBeNull();
    // 状态徽标与来源说明直接可见。
    expect(within(readonlyCard).getByTestId("governance-readonly-badge"))
      .toHaveTextContent("已保留拷贝（只读）");
    expect(within(readonlyCard).getByTestId("governance-readonly-note")).toHaveTextContent("只读");
    // 仅保留「查看关系信息」展开：无动作按钮、无勾选、无受阻原因、无待集中管理徽标。
    expect(within(readonlyCard).queryAllByRole("button")).toHaveLength(0);
    expect(readonlyCard.querySelector("input[type='checkbox']")).toBeNull();
    expect(within(readonlyCard).queryByTestId("governance-reasons-src-readonly-original")).toBeNull();
    expect(within(readonlyCard).queryByText("待集中管理")).toBeNull();
    expect(within(readonlyCard).getByTestId("governance-relation-details")).toBeInTheDocument();
  });

  it("keeps the read-only original out of batch selection at bucket and select-all level", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=completed"],
      facade: createFacade(sourceLedger([READ_ONLY_ORIGINAL_ROW])),
    });
    await screen.findByTestId("governance-row-list");

    const bucketSelect = screen.getByTestId("governance-bucket-select-retained") as HTMLInputElement;
    expect(bucketSelect).toBeDisabled();
    const selectAll = screen.getByTestId("governance-select-all") as HTMLInputElement;
    expect(selectAll).toBeDisabled();
  });

  it("suppresses read-only actions and selection in the table view too", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=completed&view=table"],
      facade: createFacade(sourceLedger([READ_ONLY_ORIGINAL_ROW])),
    });
    await screen.findByTestId("governance-row-list");

    expect(screen.getByTestId("governance-readonly-badge")).toHaveTextContent("已保留拷贝（只读）");
    expect(screen.queryByTestId("governance-action-src-readonly-original")).toBeNull();
    expect(screen.queryByTestId("governance-select-src-readonly-original")).toBeNull();
    expect(screen.queryByTestId("governance-reasons-src-readonly-original")).toBeNull();
  });

  it("shows the encouraging pending-done state when only completed rows remain", async () => {
    await renderGovernanceApp({
      facade: createFacade(sourceLedger([RETAINED_SOURCE_ROW])),
    });
    await screen.findByTestId("governance-empty-pending");
    expect(screen.getByTestId("governance-empty-pending")).toHaveTextContent("已全部处理完");
  });

  it("keeps the neutral all-good state when the ledger has no rows at all", async () => {
    await renderGovernanceApp({
      facade: createFacade(sourceLedger([])),
    });
    await screen.findByTestId("governance-empty-state");
    expect(screen.getByTestId("governance-empty-state")).toHaveTextContent("当前关系状态良好");
  });
});

describe("RelationshipGovernancePage 单条治理", () => {
  it("runs single centralize as preview → confirm → run → verify → result", async () => {
    const { facade, tracker } = await renderGovernanceApp();
    await waitRows();

    fireEvent.click(rowAction("managed:dep-eligible"));

    // 预览：解释用户语义并加载影响事实（备份/共享影响/回退）。
    expect(await screen.findByRole("dialog", { name: "纳入技能库管理预览" })).toBeVisible();
    expect(screen.getByText(/保留当前位置的可用入口，改为使用技能库中的统一版本/)).toBeVisible();
    await screen.findByTestId("removal-impact-facts");

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "centralize_management",
      confirmations: {},
      relationIds: ["managed:dep-eligible"],
    }));
    await waitFor(() => expect(facade.commitGovernanceBatch).toHaveBeenCalledWith("batch-1", ["managed:dep-eligible"]));

    // 结果 + 校验：清单被重新读取以反映执行结果。
    await screen.findByText(/已纳入技能库管理/);
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledTimes(2));

    // 父子任务进 tracker：父批次 + 子迁移任务关联持久化 operation id。
    const parent = tracker.getSnapshot().find((operation) => operation.kind === "relation_governance_batch");
    expect(parent).toBeDefined();
    const child = tracker.getSnapshot().find((operation) => operation.kind === "migrate_relation");
    expect(child?.parentId).toBe(parent?.id);
    expect(child?.operationId).toBe("op-child-1");
  });

  it("keeps the preview and never flips to success when the backend rejects", async () => {
    const facade = createFacade(FULL_LEDGER, {
      prepareGovernanceBatch: vi.fn().mockRejectedValue(new Error("operation.conflict")),
    });
    await renderGovernanceApp({ facade });
    await waitRows();

    fireEvent.click(rowAction("managed:dep-eligible"));
    await screen.findByRole("dialog", { name: "纳入技能库管理预览" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    // 预览保持打开：错误可见、没有成功文案、没有调用 commit。
    await screen.findByRole("alert");
    expect(screen.getByText(/预览保持不变/)).toBeVisible();
    expect(screen.queryByText(/已纳入技能库管理/)).not.toBeInTheDocument();
    expect(facade.commitGovernanceBatch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "纳入技能库管理预览" })).toBeVisible();
  });

  it("runs single undeploy through preview → confirm → run → result", async () => {
    const { facade, tracker } = await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
    });
    await waitRows();

    fireEvent.click(rowAction("managed:dep-undeploy"));
    expect(await screen.findByRole("dialog", { name: "从 Agent/项目移除预览" })).toBeVisible();
    await screen.findByTestId("removal-impact-facts");

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(facade.prepareRelationUndeploy).toHaveBeenCalledWith(MANAGED_ROW.relation));
    // K2/G-07：共享决定始终随提交透传；该行无需共享确认时为显式 false。
    await waitFor(() => expect(facade.commitRelationUndeploy).toHaveBeenCalledWith("op-undeploy-1", { confirmSharedTargetRemoval: false }));
    await screen.findByText(/已从目标移除/);
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledTimes(2));
    const undeployOp = tracker.getSnapshot().find((operation) => operation.kind === "undeploy");
    expect(undeployOp?.operationId).toBe("op-undeploy-1");
  });

  it("passes the confirmed shared-target decision into the undeploy commit", async () => {
    // K2/G-07：共享目标行在预览里勾选显式确认后，提交载荷必须携带
    // confirmSharedTargetRemoval=true，不得丢弃用户的共享决定。
    const facade = createFacade(sharedUndeployLedger(), {
      commitRelationUndeploy: vi.fn().mockResolvedValue(undeployResult()),
    });
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade,
    });
    await screen.findByTestId("governance-row-list");
    await screen.findByText("共享移除 PDF");

    // 该行第一个动作槽位是「纳入技能库管理」（仅差共享确认）；「从
    // Agent/项目移除」用带动作名的独立 testid 定位。
    fireEvent.click(screen.getByTestId("governance-action-undeploy-managed:dep-shared-undeploy"));
    expect(await screen.findByRole("dialog", { name: "从 Agent/项目移除预览" })).toBeVisible();
    fireEvent.click(await screen.findByRole("checkbox", { name: "我已确认共享目录影响" }));
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(facade.commitRelationUndeploy).toHaveBeenCalledWith("op-undeploy-1", { confirmSharedTargetRemoval: true }));
  });

  it("reports a single undeploy failure in the notification center with the inline description", async () => {
    // 用户裁决「写入失败也留痕」：单条解除部署关系失败必须同时进通知中心；
    // 通知详情与页面行内提示是同一份可读描述（带原始错误码，绝不 [object Object]）。
    const facade = createFacade(FULL_LEDGER, {
      commitRelationUndeploy: vi.fn().mockRejectedValue({ code: "io.denied" }),
    });
    const { tracker } = await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade,
      notifications: true,
    });
    await waitRows();

    fireEvent.click(rowAction("managed:dep-undeploy"));
    await screen.findByRole("dialog", { name: "从 Agent/项目移除预览" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    const readable = "操作未能完成（io.denied）。若持续出现请记录该错误码。";
    // 桥先发通知、rethrow 后行内才 setState：等两个通道都出现同一份描述。
    await waitFor(() => expect(screen.getAllByText(readable).length).toBeGreaterThanOrEqual(2));
    const toast = await screen.findByTestId("notice-danger");
    expect(toast).toHaveTextContent(readable);
    expect(toast).not.toHaveTextContent("[object Object]");
    const failed = tracker.getSnapshot().find((operation) => operation.kind === "undeploy");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(readable);
  });

  it("reports a rejected governance batch in the notification center while keeping the preview", async () => {
    const facade = createFacade(FULL_LEDGER, {
      prepareGovernanceBatch: vi.fn().mockRejectedValue({ code: "io.denied" }),
    });
    await renderGovernanceApp({ facade, notifications: true });
    await waitRows();

    fireEvent.click(rowAction("managed:dep-eligible"));
    await screen.findByRole("dialog", { name: "纳入技能库管理预览" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    const readable = "操作未能完成（io.denied）。若持续出现请记录该错误码。";
    const toast = await screen.findByTestId("notice-danger");
    expect(toast).toHaveTextContent(readable);
    // 既有行内契约不变：预览保持打开、错误可见、不翻成成功。
    expect(screen.getByText(/预览保持不变/)).toBeVisible();
    expect(facade.commitGovernanceBatch).not.toHaveBeenCalled();
  });

  it("locks only the busy relation and keeps other rows operable", async () => {
    await renderGovernanceApp({ entries: ["/relationships/governance?governance=all"] });
    await waitRows();

    fireEvent.click(rowAction("managed:dep-eligible"));
    await screen.findByRole("dialog", { name: "纳入技能库管理预览" });

    // 同一条关系的按钮互斥（禁用），其他关系的按钮仍然可用。
    expect(rowAction("managed:dep-eligible")).toBeDisabled();
    expect(rowAction("managed:dep-shared")).toBeEnabled();
    expect(rowAction("managed:dep-undeploy")).toBeEnabled();
  });

  it("surfaces a failed single centralize per item instead of success", async () => {
    // 后端在单项失败时仍 Ok 返回批次结果（state=failed + failed 项）：
    // 页面必须逐项如实呈现，绝不翻成成功文案。
    const facade = createFacade(FULL_LEDGER, {
      prepareGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
        items: [batchItem({ relation_id: "managed:dep-eligible", state: "prepared", operation_id: "op-child-9" })],
        prepared_count: 1,
      })),
      commitGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
        state: "failed",
        items: [batchItem({
          relation_id: "managed:dep-eligible",
          operation_id: "op-child-9",
          state: "failed",
          error_code: "operation.conflict",
          detail: "内容在中途发生变化",
        })],
        prepared_count: 1,
        failed_count: 1,
      })),
    });
    const { tracker } = await renderGovernanceApp({ facade });
    await waitRows();

    fireEvent.click(rowAction("managed:dep-eligible"));
    await screen.findByRole("dialog", { name: "纳入技能库管理预览" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    // 如实的失败终态：逐项失败信息 + 重试/回退入口。
    await screen.findByText("本次没有成功，请逐条查看失败原因");
    expect(screen.queryByText(/已纳入技能库管理：/)).not.toBeInTheDocument();
    const failedItem = screen.getByTestId("governance-batch-result-managed:dep-eligible");
    expect(failedItem).toHaveTextContent("失败");
    expect(failedItem).toHaveTextContent("内容在中途发生变化");
    expect(screen.getByRole("button", { name: "重试 managed:dep-eligible" })).toBeEnabled();
    expect(failedItem).toHaveTextContent("可回退");

    // tracker 父任务同样落 failed 终态。
    const parent = tracker.getSnapshot().find((operation) => operation.kind === "relation_governance_batch");
    expect(parent?.status).toBe("failed");
  });

  it("requires explicit shared-impact confirmation before centralizing a needs-validation row", async () => {
    const { facade } = await renderGovernanceApp();
    await waitRows();

    fireEvent.click(rowAction("managed:dep-shared"));
    await screen.findByRole("dialog", { name: "纳入技能库管理预览" });

    // 未勾选共享影响确认前，确认按钮保持禁用。
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("我已确认共享目录影响"));
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "centralize_management",
      confirmations: { "managed:dep-shared": "shared_impact_confirmed" },
      relationIds: ["managed:dep-shared"],
    }));
  });
});

describe("RelationshipGovernancePage 批量治理", () => {
  async function openBatchDialog(options: RenderOptions = {}) {
    const context = await renderGovernanceApp(options);
    await waitRows();
    fireEvent.click(screen.getByLabelText("全选本页关系"));
    fireEvent.click(screen.getByRole("button", { name: "批量纳入技能库管理" }));
    await screen.findByRole("dialog", { name: "批量纳入技能库管理" });
    return context;
  }

  it("select-all includes only rows with an authoritative batch action", async () => {
    await renderGovernanceApp({ entries: ["/relationships/governance?governance=all"] });
    await waitRows();

    fireEvent.click(screen.getByLabelText("全选本页关系"));

    // 受阻行默认不选中；其余行选中。
    expect(rowCheckbox("observed:agent.codex:broken").checked).toBe(false);
    expect(rowCheckbox("observed:agent.codex:broken")).toBeDisabled();
    expect(rowCheckbox("managed:dep-eligible").checked).toBe(true);
    expect(rowCheckbox("managed:dep-shared").checked).toBe(true);
    expect(rowCheckbox("managed:dep-undeploy").checked).toBe(false);
    expect(rowCheckbox("managed:dep-undeploy")).toBeDisabled();

    // 汇总：可执行（可纳入 + 仅待共享确认）与受阻分开呈现。
    expect(screen.getByTestId("governance-batch-summary")).toHaveTextContent("可执行 2");
    expect(screen.getByTestId("governance-batch-summary")).toHaveTextContent("已选 2 条");
  });

  it("excludes unavailable rows from batch scope and allows cancelling one selected item", async () => {
    const { facade } = await openBatchDialog();

    expect(screen.queryByTestId("governance-batch-item-observed:agent.codex:notes")).not.toBeInTheDocument();

    // 逐项取消：取消共享影响行后，prepare 只带剩余一条。
    const sharedCheckbox = screen.getByTestId("governance-batch-check-managed:dep-shared") as HTMLInputElement;
    expect(sharedCheckbox.checked).toBe(true);
    fireEvent.click(sharedCheckbox);
    expect(sharedCheckbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "确认执行 1 条" }));
    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "centralize_management",
      confirmations: {},
      relationIds: ["managed:dep-eligible"],
    }));
    expect(facade.commitGovernanceBatch).toHaveBeenCalledWith("batch-1", ["managed:dep-eligible"]);
  });

  it("requires shared-impact confirmation inside the batch before confirming", async () => {
    const { facade } = await openBatchDialog();

    const confirmButton = screen.getByRole("button", { name: "确认执行 2 条" });
    // 共享影响未确认时不能执行。
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(facade.prepareGovernanceBatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("我已确认 共享 PDF 对共享目录的影响"));
    fireEvent.click(screen.getByRole("button", { name: "确认执行 2 条" }));

    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "centralize_management",
      confirmations: { "managed:dep-shared": "shared_impact_confirmed" },
      relationIds: ["managed:dep-eligible", "managed:dep-shared"],
    }));
  });

  it("reports partial failure per item with retry and rollback info, never as full success", async () => {
    const facade = createFacade(FULL_LEDGER, {
      prepareGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
        items: [
          batchItem({ relation_id: "managed:dep-eligible", state: "prepared" }),
          batchItem({ relation_id: "managed:dep-shared", state: "prepared", operation_id: "op-child-2" }),
        ],
        prepared_count: 2,
      })),
      commitGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
        state: "partially_committed",
        items: [
          batchItem({ relation_id: "managed:dep-eligible", state: "committed" }),
          batchItem({
            relation_id: "managed:dep-shared",
            operation_id: "op-child-2",
            state: "failed",
            error_code: "operation.conflict",
            detail: "内容已变化，需要重新校验",
          }),
        ],
        prepared_count: 2,
        committed_count: 1,
        failed_count: 1,
      })),
    });
    const { tracker } = await openBatchDialog({ facade });

    fireEvent.click(screen.getByLabelText("我已确认 共享 PDF 对共享目录的影响"));
    fireEvent.click(screen.getByRole("button", { name: "确认执行 2 条" }));

    // 部分成功必须逐项呈现：成功一条、失败一条（含错误明细与重试/回退信息）。
    await screen.findByText("部分成功：1 条成功，1 条失败");
    expect(screen.queryByText(/已全部纳入技能库管理/)).not.toBeInTheDocument();
    const failedItem = screen.getByTestId("governance-batch-result-managed:dep-shared");
    expect(failedItem).toHaveTextContent("失败");
    expect(failedItem).toHaveTextContent("内容已变化，需要重新校验");
    expect(screen.getByRole("button", { name: "重试 managed:dep-shared" })).toBeEnabled();
    expect(failedItem).toHaveTextContent("可回退");

    // 父任务终态是 partial，不汇总成成功。
    const parent = tracker.getSnapshot().find((operation) => operation.kind === "relation_governance_batch");
    expect(parent?.status).toBe("partial");
  });

  it("retries a failed item as its own tracked run", async () => {
    const facade = createFacade(FULL_LEDGER, {
      prepareGovernanceBatch: vi.fn()
        .mockResolvedValueOnce(batchOutcome({
          items: [
            batchItem({ relation_id: "managed:dep-eligible", state: "prepared" }),
            batchItem({ relation_id: "managed:dep-shared", state: "prepared", operation_id: "op-child-2" }),
          ],
          prepared_count: 2,
        }))
        .mockResolvedValue(batchOutcome({
          items: [batchItem({ relation_id: "managed:dep-shared", state: "prepared", operation_id: "op-child-3" })],
          prepared_count: 1,
        })),
      commitGovernanceBatch: vi.fn()
        .mockResolvedValueOnce(batchOutcome({
          state: "partially_committed",
          items: [
            batchItem({ relation_id: "managed:dep-eligible", state: "committed" }),
            batchItem({
              relation_id: "managed:dep-shared",
              operation_id: "op-child-2",
              state: "failed",
              error_code: "operation.conflict",
            }),
          ],
          prepared_count: 2,
          committed_count: 1,
          failed_count: 1,
        }))
        .mockResolvedValue(batchOutcome({
          state: "committed",
          items: [batchItem({ relation_id: "managed:dep-shared", operation_id: "op-child-3", state: "committed" })],
          prepared_count: 1,
          committed_count: 1,
        })),
    });
    await openBatchDialog({ facade });

    fireEvent.click(screen.getByLabelText("我已确认 共享 PDF 对共享目录的影响"));
    fireEvent.click(screen.getByRole("button", { name: "确认执行 2 条" }));
    await screen.findByText("部分成功：1 条成功，1 条失败");

    fireEvent.click(screen.getByRole("button", { name: "重试 managed:dep-shared" }));

    await screen.findByText("已全部纳入技能库管理（2 条）");
    expect(facade.prepareGovernanceBatch).toHaveBeenLastCalledWith({
      action: "centralize_management",
      confirmations: { "managed:dep-shared": "shared_impact_confirmed" },
      relationIds: ["managed:dep-shared"],
    });
  });
});

describe("RelationshipGovernancePage 来源返回与视图状态", () => {
  it.each([
    ["library", "返回技能库", "/library", "LIBRARY_ORIGIN"],
    ["graph", "返回技能图谱", "/relationships", "GRAPH_ORIGIN"],
    ["conflict", "返回冲突处理", "/relationships/decisions", "DECISIONS_ORIGIN"],
    ["agent", "返回 Agent 详情", "/agents/agent-a", "AGENT_ORIGIN"],
    ["project", "返回项目详情", "/projects/project-a", "PROJECT_ORIGIN"],
  ] as const)("labels the back affordance after entering from %s and returns to the origin", async (
    from,
    backLabel,
    originPath,
    originText,
  ) => {
    await renderGovernanceApp({
      entries: [originPath, `/relationships/governance?from=${from}`],
      initialIndex: 1,
    });
    await waitRows();

    fireEvent.click(screen.getByRole("button", { name: backLabel }));
    expect(await screen.findByText(originText)).toBeVisible();
  });

  it("deep-links carry filters: agent source filters by client id, library by skill", async () => {
    const agentFacade = createFacade();
    const agentRender = await renderGovernanceApp({
      entries: ["/relationships/governance?from=agent&agent=codex"],
      facade: agentFacade,
    });
    await waitRows();
    expect(agentFacade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ agent_client_id: "codex" }),
    );
    agentRender.unmount();

    const libraryFacade = createFacade();
    await renderGovernanceApp({
      entries: ["/relationships/governance?from=library&skillId=skill-pdf"],
      facade: libraryFacade,
    });
    await screen.findByText("PDF 阅读器");
    expect(libraryFacade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ skill_id: "skill-pdf" }),
    );
  });

  it("returns to the validated Skill detail route and restores its library return state", async () => {
    const libraryReturn = { focusSkillId: "skill-pdf", scrollLeft: 16, scrollTop: 412 };
    await renderGovernanceApp({
      entries: [{
        pathname: "/relationships/governance",
        search: "?from=library&skillId=skill-pdf&relationId=managed:dep-eligible",
        state: {
          libraryReturn,
          returnTo: "/library/skill-pdf?q=pdf&sort=version%3Adesc",
          targetIdentity: {
            skill_id: "skill-pdf",
            target_kind: "agent",
            directory_node_id: "node-codex",
            entry_path_key: "c:/agents/codex/skills/pdf-reader",
          },
        },
      }],
    });
    await waitRows();

    fireEvent.click(screen.getByRole("button", { name: "返回技能库" }));

    expect(await screen.findByTestId("skill-detail-origin")).toBeVisible();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/library/skill-pdf");
    expect(screen.getByTestId("location-search")).toHaveTextContent("?q=pdf&sort=version%3Adesc");
    expect(screen.getByTestId("location-state")).toHaveTextContent(JSON.stringify({ libraryReturn }));
  });

  // W3-3b：抽屉发起的治理深链返回形状为 `/library?skill=<id>`——回到库列表并
  // 通过 skill 参数重开快捷抽屉；返回上下文校验与详情形状同一套白名单。
  it("returns to the library list and reopens the drawer for a drawer-origin returnTo", async () => {
    await renderGovernanceApp({
      entries: [{
        pathname: "/relationships/governance",
        search: "?from=library&skillId=skill-pdf&relationId=managed:dep-eligible",
        state: { returnTo: "/library?q=pdf&skill=skill-pdf" },
      }],
    });
    await waitRows();

    fireEvent.click(screen.getByRole("button", { name: "返回技能库" }));

    expect(await screen.findByText("LIBRARY_ORIGIN")).toBeVisible();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/library");
    expect(screen.getByTestId("location-search")).toHaveTextContent("?q=pdf&skill=skill-pdf");
    expect(screen.getByTestId("location-state")).toHaveTextContent("null");
  });

  it.each([
    ["external URL", "https://evil.example/"],
    ["protocol-relative URL", "//evil.example/library/skill-pdf"],
    ["encoded path separator", "/library/%2f%2fevil"],
    ["double-encoded separator", "/library/%252f%252fevil"],
    ["backslash", String.raw`/library/skill-pdf\..\evil`],
    ["unapproved route", "/relationships/governance"],
  ])("uses the safe library fallback for an invalid direct-open returnTo (%s)", async (_label, returnTo) => {
    await renderGovernanceApp({
      entries: [{
        pathname: "/relationships/governance",
        search: "?from=library&skillId=skill-pdf",
        state: {
          libraryReturn: { focusSkillId: "skill-pdf", scrollLeft: "bad", scrollTop: 4 },
          returnTo,
        },
      }],
    });
    await waitRows();
    expect(screen.getByTestId("governance-return-context-warning")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "返回技能库" }));

    expect(screen.getByText("LIBRARY_ORIGIN")).toBeVisible();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/library");
    expect(screen.getByTestId("location-state")).toHaveTextContent("null");
  });

  it("rejects a returnTo pointing at another Skill and falls back to the library", async () => {
    await renderGovernanceApp({
      entries: [{
        pathname: "/relationships/governance",
        search: "?from=library&skillId=skill-pdf",
        state: {
          libraryReturn: { focusSkillId: "skill-pdf", scrollLeft: 0, scrollTop: 0 },
          returnTo: "/library/another-skill?q=pdf",
        },
      }],
    });
    await waitRows();
    expect(screen.getByTestId("governance-return-context-warning")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "返回技能库" }));

    expect(screen.getByTestId("location-path")).toHaveTextContent("/library");
    expect(screen.getByTestId("location-state")).toHaveTextContent("null");
  });

  it("falls back to the library when opened directly without navigation history", async () => {
    await renderGovernanceApp({ entries: ["/relationships/governance?from=library&skillId=skill-pdf"] });
    await waitRows();

    fireEvent.click(screen.getByRole("button", { name: "返回技能库" }));

    expect(await screen.findByText("LIBRARY_ORIGIN")).toBeVisible();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/library");
  });

  it("opens the governance preview for a deep-linked relationId", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?from=conflict&conflictId=case-1&relationId=managed:dep-shared"],
    });
    await waitRows();
    expect(await screen.findByRole("dialog", { name: "纳入技能库管理预览" })).toBeVisible();
  });

  it("re-fetches the Skill ledger row and does not authorize from stale target identity state", async () => {
    const facade = createFacade();
    await renderGovernanceApp({
      entries: [{
        pathname: "/relationships/governance",
        search: "?from=library&skillId=skill-pdf&relationId=managed:dep-shared",
        state: {
          targetIdentity: {
            skill_id: "another-skill",
            target_kind: "project",
            directory_node_id: "stale-node",
            entry_path_key: "stale/path",
          },
        },
      }],
      facade,
    });

    expect(await screen.findByRole("dialog", { name: "纳入技能库管理预览" })).toBeVisible();
    expect(facade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ skill_id: "skill-pdf" }),
    );
    expect(facade.prepareGovernanceBatch).not.toHaveBeenCalled();
  });

  it("explains when an exact library relation deep link no longer resolves", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?from=library&skillId=skill-pdf&relationId=missing-relation"],
    });
    await waitRows();

    expect(await screen.findByRole("status")).toHaveTextContent("这条关系在该技能中已不可用。");
  });

  it("shows the same stale relationship fact in English", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?from=library&skillId=skill-pdf&relationId=missing-relation"],
      locale: "en-US",
    });
    await screen.findByTestId("governance-row-list");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "This relationship is no longer available for this Skill.",
    );
  });

  it("pushes classification filters into history so browser back restores the default tab", async () => {
    const { facade } = await renderGovernanceApp({
      entries: ["/agents/agent-a", "/relationships/governance?from=agent&agent=codex"],
      initialIndex: 1,
    });
    await waitRows();

    // 已提交筛选写入历史。切到已完成页签后后退一步回到默认待处理页签，
    // 再后退才离开治理页回 Agent 详情。
    fireEvent.click(screen.getByTestId("governance-bucket-completed"));
    expect(screen.getByTestId("location-search")).toHaveTextContent("governance=completed");
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "all", agent_client_id: "codex" }),
    ));
    await screen.findByTestId("governance-row-list");

    fireEvent.click(screen.getByTestId("nav-back"));
    expect(await screen.findByTestId("governance-bucket-pending")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(facade.listGovernance).toHaveBeenLastCalledWith(
      expect.objectContaining({ bucket: "all", agent_client_id: "codex" }),
    ));

    fireEvent.click(screen.getByTestId("nav-back"));
    expect(await screen.findByText("AGENT_ORIGIN")).toBeVisible();
  });

  it("restores selection, filters and scroll after leaving to a detail and returning", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?view=table", "/operations/op-1"],
    });
    await waitRows();

    fireEvent.click(rowCheckbox("managed:dep-eligible"));
    fireEvent.click(screen.getByTestId("governance-bucket-pending"));
    // 等待当前治理分类下的清单重新就绪，再在清单上留下滚动位置。
    await waitFor(() => expect(screen.getAllByTestId("governance-row")).toHaveLength(4));
    const list = screen.getByTestId("governance-row-list");
    list.scrollTop = 240;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByTestId("nav-depart"));
    expect(await screen.findByText("OPERATION_PAGE")).toBeVisible();

    fireEvent.click(screen.getByTestId("nav-back"));
    await waitRows();

    // 回到治理页：筛选、勾选与滚动位置都保留。
    expect(screen.getByTestId("governance-bucket-pending")).toHaveAttribute("aria-pressed", "true");
    expect(rowCheckbox("managed:dep-eligible").checked).toBe(true);
    expect(screen.getByTestId("governance-row-list").scrollTop).toBe(240);
  });
});

describe("RelationshipsPages 治理插槽", () => {
  it("replaces the governance placeholder with the real workbench", async () => {
    const i18n = await createSkillHubI18n(["zh-CN"]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/relationships/governance"]}>
            <Routes>
              <Route element={<RelationshipsGovernancePage />} path="/relationships/governance" />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );

    // 走 mocked native facade：加载失败也证明插槽已换成真实工作台而非占位。
    expect(await screen.findByTestId("governance-deploy-entry")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("关系治理清单暂不可用");
    expect(screen.queryByText(/关系治理工作台尚未提供/)).not.toBeInTheDocument();
  });
});

// —— 任务 11：全部可管理关系——来源治理入口、状态/scope 筛选与 URL 恢复 ——

const SOURCE_ROW: RelationGovernanceRow = {
  relation: {
    kind: "source_copy",
    fact: {
      relation_id: "src-import-1",
      skill_id: "skill-pdf",
      latest_provenance_id: "prov-1",
      source_class: "agent_local",
      source_path: "C:\\agents\\codex\\skills\\pdf-reader",
      source_path_key: "c:/agents/codex/skills/pdf-reader",
      physical_source_id: "phys-1",
      source_container_id: null,
      directory_node_id: "node-codex",
      agent_client_id: "codex",
      expected_fingerprint: "sha256:aaa",
      current_fingerprint: "sha256:aaa",
      decision: "pending",
      health: "needs_validation",
      active: true,
      last_verified_at: null,
      archived_at: null,
      archive_reason: null,
    },
  },
  status: "needs_attention",
  skill_display_name: "共享 PDF",
  readiness: "needs_validation",
  primary_action: "revalidate",
  blockers: [],
  impact: {
    other_consumer_agent_ids: [],
    other_skill_paths: [],
    backup_required: false,
    rollback_available: true,
  },
  governance: {
    governance_status: "pending",
    management_status: "not_taken_over",
    decision: "undecided",
    management_confirmed_at: null,
    health_reasons: ["verification_required"],
    action_conditions: [
      { action: "centralize_management", available: false, reasons: ["verification_required"] },
      { action: "revalidate", available: true, reasons: [] },
    ],
  },
  target_identity: null,
  source_read_only: false,
  evidence_relation_ids: ["src-import-1"],
};

describe("RelationshipGovernancePage 来源治理入口（任务 11）", () => {
  it("enters with the pending tab active by default and no import banner", async () => {
    const { facade } = await renderGovernanceApp();
    await waitRows();

    expect(screen.getByTestId("governance-bucket-pending")).toHaveAttribute("aria-pressed", "true");
    expect(facade.listGovernance).toHaveBeenCalledWith(expect.objectContaining({ bucket: "all" }));
    expect(screen.queryByTestId("governance-import-banner")).not.toBeInTheDocument();
  });

  it("applies the import deep link to pending source copies and the batch, then announces the count", async () => {
    const ledger: RelationGovernanceLedger = {
      ...FULL_LEDGER,
      rows: [SOURCE_ROW],
      total: 1,
    };
    const { facade } = await renderGovernanceApp({
      entries: [
        "/relationships/governance?from=import&scope=source_copy&governance=pending&batch=import-b-9",
      ],
      facade: createFacade(ledger),
    });

    // 导入完成页深链直达“本次导入”的治理上下文：横幅宣布本地来源副本数。
    expect(await screen.findByTestId("governance-import-banner")).toHaveTextContent(
      "本次导入留下 1 个本地来源副本",
    );
    expect(facade.listGovernance).toHaveBeenCalledWith(expect.objectContaining({
      bucket: "all",
      batch_id: "import-b-9",
    }));
    // scope 已按深链收紧：部署边不出现，页签停在待处理。
    expect(screen.queryByTestId("governance-select-managed:dep-eligible")).not.toBeInTheDocument();
    expect(screen.getByTestId("governance-bucket-pending")).toHaveAttribute("aria-pressed", "true");
    // 批次 id 只进 URL，不进页面文本。
    expect(screen.queryByText("import-b-9")).not.toBeInTheDocument();
  });
});

// —— 11.4 行展示：两类关系同一字段顺序、Agent 徽标、displayPath、技术 ID 只进技术细节 ——

describe("RelationshipGovernancePage 行展示（任务 11.4）", () => {
  it("renders source copies and deployments with the same field order and agent badges only on deployments", async () => {
    const ledger: RelationGovernanceLedger = {
      ...FULL_LEDGER,
      rows: [SOURCE_ROW, ELIGIBLE_ROW],
      total: 2,
    };
    await renderGovernanceApp({
      entries: ["/relationships/governance?view=table"],
      facade: createFacade(ledger),
    });
    const rows = await screen.findAllByTestId("governance-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("导入来源")).toBeVisible();

    // 两类关系的单元格数量与列语义一致：选择、名称、来源、目标、影响、校验、操作。
    const sourceCells = rows[0]!.querySelectorAll("td");
    const deployCells = rows[1]!.querySelectorAll("td");
    expect(sourceCells).toHaveLength(deployCells.length);
    expect(within(sourceCells[1]!).getByText("共享 PDF")).toBeVisible();

    // Agent 徽标只出现在部署边；来源副本边不重复出卡。
    expect(rows[0]!.querySelector(".sh-agent-presentation")).toBeNull();
    expect(rows[1]!.querySelector(".sh-agent-presentation")).not.toBeNull();

    // 路径统一经 displayPath：Windows 形态统一反斜杠，无 `\\?\` 内部前缀，不混排斜杠。
    const targetCell = within(rows[0]!).getByTestId("governance-target-src-import-1");
    expect(targetCell.textContent).toContain("C:\\agents\\codex\\skills\\pdf-reader");
    expect(targetCell.textContent).not.toContain("C:/agents");
    expect(targetCell.textContent).not.toContain("\\\\?\\");

    // 技术 ID 不进主界面：勾选框可读名称用技能名，行内可见文本不出现 relation id。
    const select = within(rows[0]!).getByTestId("governance-select-src-import-1");
    expect(select).toHaveAttribute("aria-label", "选择关系 共享 PDF");
    expect(rows[0]!.textContent).not.toContain("src-import-1");
  });
});

// —— 11.5 真实重校验：按钮走 facade.revalidate（RunRelationshipCheck），逐项进度/结果，不允许仅 refetch ——

describe("RelationshipGovernancePage 逐行重校验（任务 11.5）", () => {
  it("runs a real revalidate for a row, shows per-item result, and refreshes the ledger afterwards", async () => {
    let resolveCheck: (value: RelationshipCheckReport) => void = () => {};
    const ledger: RelationGovernanceLedger = {
      ...FULL_LEDGER,
      rows: [STALE_VERIFICATION_ROW],
      total: 1,
    };
    const facade = createFacade(ledger, {
      revalidate: vi.fn().mockImplementation(
        () => new Promise<RelationshipCheckReport>((resolve) => {
          resolveCheck = resolve;
        }),
      ),
    });
    await renderGovernanceApp({ facade });
    await screen.findByTestId("governance-action-observed:agent.codex:notes");

    fireEvent.click(screen.getByTestId("governance-action-observed:agent.codex:notes"));

    // 命令先行：点按钮触发的是 RunRelationshipCheck，携带该行 relation id。
    expect((facade.revalidate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
      .toEqual(["observed:agent.codex:notes"]);
    // 逐项进度：该校验未完成前，动作按钮处于 busy 不可重复触发。
    expect(screen.getByTestId("governance-action-observed:agent.codex:notes")).toBeDisabled();

    resolveCheck({
      items: [{
        relation_id: "observed:agent.codex:notes",
        skill_id: "observed:agent.codex:notes",
        status: "checked",
        health: null,
        reason: null,
      }],
      relationship_revision: "9",
    });
    // 逐项结果：完成后按 relation 展示结论，而不是全局转圈。
    expect(await screen.findByTestId("governance-revalidate-result-observed:agent.codex:notes"))
      .toHaveTextContent("校验完成");
    // 不是仅 refetch：命令执行后才失效清单重新拉取。
    await waitFor(() => expect((facade.listGovernance as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThanOrEqual(2));
  });

  it("surfaces a failed revalidate item without dropping the row", async () => {
    const ledger: RelationGovernanceLedger = {
      ...FULL_LEDGER,
      rows: [STALE_VERIFICATION_ROW],
      total: 1,
    };
    const facade = createFacade(ledger, {
      revalidate: vi.fn().mockResolvedValue({
        items: [{
          relation_id: "observed:agent.codex:notes",
          skill_id: "observed:agent.codex:notes",
          status: "failed",
          health: "permission_limited",
          reason: "EACCES",
        }],
        relationship_revision: "9",
      } satisfies RelationshipCheckReport),
    });
    await renderGovernanceApp({ facade });
    await screen.findByTestId("governance-action-observed:agent.codex:notes");

    fireEvent.click(screen.getByTestId("governance-action-observed:agent.codex:notes"));

    // 失败结论就地可见，行保留，可再次校验。
    expect(await screen.findByTestId("governance-revalidate-result-observed:agent.codex:notes"))
      .toHaveTextContent("校验失败");
    expect(await screen.findByTestId("governance-action-observed:agent.codex:notes")).toBeEnabled();
  });
});

// —— 11.7/11.8/11.9：来源副本动作（清理/保留）、清理影响预览与清理结果 ——

interface SourceRowSpec {
  relationId: string;
  displayName?: string | null;
  decision: SourceCopyRelationFact["decision"];
  health: SourceCopyRelationFact["health"];
  status: RelationGovernanceRow["status"];
  readiness: RelationGovernanceRow["readiness"];
  primaryAction: RelationGovernanceRow["primary_action"];
  blockers?: RelationGovernanceRow["blockers"];
  governance?: RelationGovernanceRow["governance"];
  /** FB-④：只读目录导入原件——权限边界内的正常终态。 */
  sourceReadOnly?: boolean;
}

function makeSourceRow(spec: SourceRowSpec): RelationGovernanceRow {
  return {
    relation: {
      kind: "source_copy",
      fact: {
        relation_id: spec.relationId,
        skill_id: "skill-pdf",
        latest_provenance_id: "prov-1",
        source_class: "agent_local",
        source_path: "C:\\agents\\codex\\skills\\pdf-reader",
        source_path_key: "c:/agents/codex/skills/pdf-reader",
        physical_source_id: "phys-1",
        source_container_id: null,
        directory_node_id: "node-codex",
        agent_client_id: "codex",
        expected_fingerprint: "sha256:aaa",
        current_fingerprint: "sha256:aaa",
        decision: spec.decision,
        health: spec.health,
        active: true,
        last_verified_at: null,
        archived_at: null,
        archive_reason: null,
      },
    },
    status: spec.status,
    skill_display_name: spec.displayName ?? "共享 PDF",
    readiness: spec.readiness,
    primary_action: spec.primaryAction,
    blockers: spec.blockers ?? [],
    impact: {
      other_consumer_agent_ids: [],
      other_skill_paths: [],
      backup_required: false,
      rollback_available: true,
    },
    governance: spec.governance ?? {
      governance_status: spec.decision === "retained" ? "completed" : "pending",
      management_status: "not_taken_over",
      decision: spec.decision === "retained" ? "retained_independent_copy" : "undecided",
      management_confirmed_at: null,
      health_reasons: spec.health === "normal" ? [] : spec.health === "permission_limited"
        ? ["permission_limited"]
        : ["content_changed"],
      action_conditions: spec.primaryAction === "keep_independent_copy"
        ? [{ action: "keep_independent_copy", available: true, reasons: [] }]
        : spec.primaryAction === "revalidate"
          ? [{ action: "revalidate", available: true, reasons: [] }]
          : [],
    },
    target_identity: null,
    source_read_only: spec.sourceReadOnly ?? false,
    evidence_relation_ids: [spec.relationId],
  };
}

const PENDING_SOURCE_ROW = makeSourceRow({
  relationId: "src-pending",
  decision: "pending",
  health: "normal",
  status: "needs_attention",
  readiness: "needs_validation",
  primaryAction: "keep_independent_copy",
});

const RETAINED_SOURCE_ROW = makeSourceRow({
  relationId: "src-retained",
  decision: "retained",
  health: "normal",
  status: "retained",
  readiness: "needs_validation",
  primaryAction: "none",
});

const BLOCKED_SOURCE_ROW = makeSourceRow({
  relationId: "src-blocked",
  decision: "pending",
  health: "managed_occupied",
  status: "blocked",
  readiness: "blocked",
  primaryAction: "none",
  blockers: ["directory_recognition_unsupported"],
});

function sourceLedger(rows: RelationGovernanceRow[]): RelationGovernanceLedger {
  return { ...FULL_LEDGER, rows, total: rows.length };
}

describe("RelationshipGovernancePage 来源副本动作（任务 11.7-11.9）", () => {
  it("uses authoritative governance facts when legacy readiness says already centralized", async () => {
    const normalSource = makeSourceRow({
      relationId: "src-pending-legacy-ready",
      decision: "pending",
      health: "normal",
      status: "normal",
      readiness: "already_centralized",
      primaryAction: "none",
      governance: {
        governance_status: "pending",
        management_status: "not_taken_over",
        decision: "undecided",
        management_confirmed_at: null,
        health_reasons: [],
        action_conditions: [{ action: "keep_independent_copy", available: true, reasons: [] }],
      },
    });
    const retainedSource = makeSourceRow({
      relationId: "src-retained-centralized-readiness",
      decision: "retained",
      health: "normal",
      status: "retained",
      readiness: "already_centralized",
      primaryAction: "none",
    });
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade: createFacade(sourceLedger([normalSource, retainedSource])),
    });
    await screen.findByTestId("governance-row-list");

    const sourceCards = screen.getAllByTestId("governance-row");
    expect(within(sourceCards[0]!).getByTestId("governance-short-name-src-pending-legacy-ready")).toHaveTextContent("待集中管理");
    expect(within(sourceCards[1]!).getByTestId("governance-short-name-src-retained-centralized-readiness")).toHaveTextContent("已保留拷贝");
    expect(sourceCards[1]).toHaveTextContent("待集中管理");
    expect(document.body).not.toHaveTextContent("已由技能库管理");
  });

  it("shows only action-condition-approved source operations and never exposes legacy cleanup", async () => {
    const facade = createFacade(sourceLedger([
      PENDING_SOURCE_ROW,
      RETAINED_SOURCE_ROW,
      SOURCE_ROW,
      BLOCKED_SOURCE_ROW,
    ]));
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade,
    });
    expect((await screen.findAllByTestId("governance-row")).length).toBe(4);

    // Pending：只显示后端允许的“保留为独立拷贝”。
    expect(screen.getByTestId("governance-action-src-pending")).toHaveTextContent("保留为独立拷贝");
    expect(screen.queryByTestId("governance-clean-src-pending")).not.toBeInTheDocument();
    // 已保留：长期保留结果在已完成列中，不再给重复操作。
    expect(screen.queryByTestId("governance-action-src-retained")).not.toBeInTheDocument();
    // 需要重新检查：仅显示 action_conditions 明确允许的复核入口。
    expect(screen.getByTestId("governance-action-src-import-1")).toBeEnabled();
    // 受限行：不提供动作，只展示具体原因。
    expect(screen.queryByTestId("governance-clean-src-blocked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-retain-src-blocked")).not.toBeInTheDocument();
    expect(screen.getByTestId("governance-reasons-src-blocked")).toBeVisible();
  });

  it("commits only the source action declared by governance and keeps the row when it fails", async () => {
    const facade = createFacade(sourceLedger([PENDING_SOURCE_ROW]), {
      retainSourceCopy: vi.fn().mockRejectedValue({ code: "io.denied" }),
    });
    const { tracker } = await renderGovernanceApp({ facade, notifications: true });
    const row = (await screen.findAllByTestId("governance-row"))[0]!;

    fireEvent.click(screen.getByTestId("governance-action-src-pending"));

    await waitFor(() => expect(facade.retainSourceCopy).toHaveBeenCalledWith("src-pending"));
    expect(await screen.findByTestId("notice-danger")).toHaveTextContent("io.denied");
    expect(row).toBeInTheDocument();
    expect(within(row).getByTestId("governance-short-name-src-pending")).toHaveTextContent("待集中管理");
    expect(facade.prepareGovernanceBatch).not.toHaveBeenCalled();
    expect(facade.getRelationshipRemovalImpact).not.toHaveBeenCalled();
    expect(tracker.getSnapshot().find((operation) => operation.kind === "retain_source_copy")?.status)
      .toBe("failed");
  });
});

describe("RelationshipGovernancePage 关系结束与撤销保留", () => {
  const retentionActions = [
    { action: "revoke_retention" as const, available: true, reasons: [] },
    { action: "end_relationship" as const, available: true, reasons: [] },
  ];

  it("uses action conditions instead of legacy readiness and explains verified-removal blockers", async () => {
    const retained = makeSourceRow({
      relationId: "src-retained-actions",
      decision: "retained",
      health: "normal",
      status: "retained",
      readiness: "already_centralized",
      primaryAction: "none",
      governance: {
        governance_status: "completed",
        management_status: "not_taken_over",
        decision: "retained_independent_copy",
        management_confirmed_at: null,
        health_reasons: [],
        action_conditions: retentionActions,
      },
    });
    const managed = makeRow({
      relationId: "managed:requires-verified-removal",
      readiness: "already_centralized",
      primaryAction: "none",
      relationship: "managed_link",
      governance: {
        governance_status: "completed",
        management_status: "taken_over",
        decision: "undecided",
        management_confirmed_at: null,
        health_reasons: [],
        action_conditions: [{
          action: "end_relationship",
          available: false,
          reasons: ["managed_entry_requires_verified_removal"],
        }],
      },
    });
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade: createFacade(sourceLedger([retained, managed])),
    });

    await screen.findByTestId("governance-action-src-retained-actions");
    const revokeButton = screen.getByTestId("governance-action-src-retained-actions");
    expect(revokeButton).toHaveTextContent("撤销保留决定");
    const retainedRow = screen.getAllByTestId("governance-row").find((row) =>
      row.querySelector('[data-action="end_relationship"]'),
    );
    expect(retainedRow).toBeDefined();
    expect(within(retainedRow!).getByRole("button", { name: "解除关系" })).toBeVisible();

    expect(screen.queryByTestId("governance-action-end_relationship-managed:requires-verified-removal"))
      .not.toBeInTheDocument();
    expect(screen.getByTestId("governance-reasons-managed:requires-verified-removal"))
      .toHaveTextContent("此目标由技能库管理；必须先验证可安全移除目标入口。解除关系不会绕过这项检查。");
  });

  it("confirms one relationship mutation with the displayed ledger revision and keeps backend failures visible", async () => {
    const retained = makeSourceRow({
      relationId: "src-retained-mutate",
      decision: "retained",
      health: "normal",
      status: "retained",
      readiness: "already_centralized",
      primaryAction: "none",
      governance: {
        governance_status: "completed",
        management_status: "not_taken_over",
        decision: "retained_independent_copy",
        management_confirmed_at: null,
        health_reasons: [],
        action_conditions: retentionActions,
      },
    });
    const facade = createFacade(sourceLedger([retained]), {
      revokeRetention: vi.fn().mockResolvedValue({
        relation_id: "src-retained-mutate",
        relationship_revision: "rev-2",
        replayed: false,
      }),
      endRelationship: vi.fn().mockRejectedValue(new Error("The relationship facts changed; reload and review before ending it.")),
    });
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade,
    });

    await screen.findByTestId("governance-action-src-retained-mutate");
    fireEvent.click(screen.getByTestId("governance-action-src-retained-mutate"));
    const revokeDialog = await screen.findByRole("dialog", { name: "撤销保留决定" });
    expect(within(revokeDialog).getByText(/不修改来源文件、目标入口或技能库 Skill 主体/)).toBeVisible();
    fireEvent.click(within(revokeDialog).getByRole("button", { name: "确认撤销保留决定" }));

    await waitFor(() => expect(facade.revokeRetention).toHaveBeenCalledWith({
      operationId: expect.any(String),
      relationId: "src-retained-mutate",
      expectedRelationshipRevision: "rev-1",
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("保留决定已撤销。当前关系状态已根据原有健康事实重新评估。");

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    const row = screen.getByTestId("governance-row");
    fireEvent.click(within(row).getByRole("button", { name: "解除关系" }));
    const endDialog = await screen.findByRole("dialog", { name: "解除关系" });
    expect(within(endDialog).getByText(/保留来源目录中的文件和技能库 Skill 主体/)).toBeVisible();
    fireEvent.click(within(endDialog).getByRole("button", { name: "确认解除关系" }));

    await waitFor(() => expect(facade.endRelationship).toHaveBeenCalledWith({
      operationId: expect.any(String),
      relationId: "src-retained-mutate",
      expectedRelationshipRevision: "rev-1",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The relationship facts changed; reload and review before ending it.",
    );
    expect(screen.getByTestId("governance-row")).toBeVisible();
    expect(screen.queryByText("关系已结束；来源文件和 Skill 主体均已保留。"))
      .not.toBeInTheDocument();
  });
});

// —— 11.10/11.15：批次收敛——不混 scope、单一动作、受阻分组、逐项取消 ——

describe("RelationshipGovernancePage 批次收敛（任务 11.10/11.15）", () => {
  it("refuses mixed selections, groups blocked rows, and lets a single cancel leave the rest intact", async () => {
    const ledger = sourceLedger([
      PENDING_SOURCE_ROW,
      RETAINED_SOURCE_ROW,
      ELIGIBLE_ROW,
      BLOCKED_ROW,
    ]);
    const facade = createFacade(ledger);
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade,
    });
    expect((await screen.findAllByTestId("governance-row")).length).toBe(4);

    fireEvent.click(screen.getByTestId("governance-select-src-pending"));
    fireEvent.click(screen.getByTestId("governance-select-managed:dep-eligible"));
    fireEvent.click(screen.getByTestId("governance-select-observed:agent.codex:broken"));
    fireEvent.click(screen.getByTestId("governance-open-batch"));

    // 来源副本与部署边混选：批次拒绝收敛，确认禁用。
    const dialog = await screen.findByTestId("governance-batch-dialog");
    expect(within(dialog).getByTestId("governance-batch-mixing")).toBeVisible();
    expect(within(dialog).getByTestId("governance-batch-confirm")).toBeDisabled();

    // 取消来源项后批次收敛为部署动作；受阻项单独分组且不可勾选。
    fireEvent.click(within(dialog).getByTestId("governance-batch-check-src-pending"));
    expect(within(dialog).queryByTestId("governance-batch-mixing")).not.toBeInTheDocument();
    const blockedItem = within(dialog).getByTestId("governance-batch-item-observed:agent.codex:broken");
    expect(within(blockedItem).getByTestId("governance-batch-check-observed:agent.codex:broken"))
      .toBeDisabled();
  });

  it("batches only source relations with an available keep-independent-copy condition", async () => {
    const secondPending = makeSourceRow({
      relationId: "src-pending-2",
      decision: "pending",
      health: "normal",
      status: "needs_attention",
      readiness: "blocked",
      primaryAction: "none",
      governance: {
        governance_status: "pending",
        management_status: "not_taken_over",
        decision: "undecided",
        management_confirmed_at: null,
        health_reasons: [],
        action_conditions: [{ action: "keep_independent_copy", available: true, reasons: [] }],
      },
    });
    const ledger = sourceLedger([PENDING_SOURCE_ROW, secondPending, RETAINED_SOURCE_ROW]);
    const facade = createFacade(ledger);
    await renderGovernanceApp({
      entries: ["/relationships/governance?governance=all"],
      facade,
    });
    expect((await screen.findAllByTestId("governance-row")).length).toBe(3);

    fireEvent.click(screen.getByTestId("governance-select-src-pending"));
    fireEvent.click(screen.getByTestId("governance-select-src-pending-2"));
    fireEvent.click(screen.getByTestId("governance-open-batch"));

    const dialog = await screen.findByTestId("governance-batch-dialog");
    expect(within(dialog).getByRole("heading", { name: "批量保留为独立拷贝" })).toBeVisible();
    expect(screen.getByTestId("governance-select-src-retained")).toBeDisabled();
    const confirm = within(dialog).getByTestId("governance-batch-confirm");
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "retain_source_copy",
      confirmations: {},
      relationIds: ["src-pending", "src-pending-2"],
    }));
    expect(facade.commitGovernanceBatch).toHaveBeenCalledTimes(1);
  });
});

// —— 11.16：清理失败保留当前行，Revalidate/Retry/Restore 全部可用 ——

describe("RelationshipGovernancePage 来源操作失败", () => {
  it("does not infer a successful decision after the source action rejects", async () => {
    const facade = createFacade(sourceLedger([PENDING_SOURCE_ROW]), {
      retainSourceCopy: vi.fn().mockRejectedValue({ code: "io.denied" }),
    });
    await renderGovernanceApp({ facade, notifications: true });

    fireEvent.click(await screen.findByTestId("governance-action-src-pending"));

    await screen.findByTestId("notice-danger");
    expect(screen.getByTestId("governance-row")).toBeVisible();
    expect(screen.getByTestId("governance-short-name-src-pending")).toHaveTextContent("待集中管理");
    expect(screen.queryByText("已保留为独立拷贝（1 条）")).not.toBeInTheDocument();
    expect(facade.retainSourceCopy).toHaveBeenCalledTimes(1);
  });
});
