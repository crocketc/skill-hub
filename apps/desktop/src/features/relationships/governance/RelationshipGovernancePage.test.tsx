import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
      <p data-testid="location-search">{location.search}</p>
      <button data-testid="nav-depart" onClick={() => navigate("/operations/op-1")}>depart</button>
      <button data-testid="nav-back" onClick={() => navigate(-1)}>back</button>
    </div>
  );
}

interface RenderOptions {
  entries?: string[];
  initialIndex?: number;
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
  const i18n = await createSkillHubI18n(["zh-CN"]);
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

describe("RelationshipGovernancePage 清单（按关系边渲染）", () => {
  it("renders one row per relationship edge with relation/source/target/impact columns", async () => {
    await renderGovernanceApp();
    await waitRows();

    // 五条关系边各一行；即使多条边属于同一个 Skill 也不按 Skill 合并。
    expect(screen.getAllByTestId("governance-row")).toHaveLength(5);
    expect(screen.getByText("PDF 阅读器")).toBeVisible();
    expect(screen.getByText("C:\\agents\\codex\\skills\\link-reader")).toBeVisible();

    expect(screen.getByTestId("governance-header-relation")).toHaveTextContent("关系");
    expect(screen.getByTestId("governance-header-source")).toHaveTextContent("来源");
    expect(screen.getByTestId("governance-header-target")).toHaveTextContent("目标");
    expect(screen.getByTestId("governance-header-impact")).toHaveTextContent("影响");
    expect(screen.getByTestId("governance-source-managed:dep-eligible")).toHaveTextContent("导入登记");
    expect(screen.getByTestId("governance-target-managed:dep-eligible")).toHaveTextContent("Codex");
    // 影响列展示其他共享消费者。
    expect(screen.getByTestId("governance-impact-managed:dep-shared")).toHaveTextContent("Cursor");
  });

  it("shows the four bucket filters with ledger counts and filters by bucket", async () => {
    const { facade } = await renderGovernanceApp();
    await waitRows();

    expect(screen.getByRole("button", { name: "全部（5）" })).toBeVisible();
    expect(screen.getByRole("button", { name: "可纳入集中库管理（1）" })).toBeVisible();
    expect(screen.getByRole("button", { name: "待校验（2）" })).toBeVisible();
    expect(screen.getByRole("button", { name: "受阻（1）" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "受阻（1）" }));
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "blocked" }),
    ));
  });

  it("explains blockers on blocked rows instead of offering an action", async () => {
    await renderGovernanceApp();
    await waitRows();

    const blockedCell = screen.getByTestId("governance-blockers-observed:agent.codex:broken");
    expect(blockedCell).toHaveTextContent("目录联接或未知表示");
    expect(rowAction("observed:agent.codex:broken")).toBeDisabled();
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
    await renderGovernanceApp();
    await waitRows();

    const deployEntry = screen.getByTestId("governance-deploy-entry");
    const deployLink = deployEntry.querySelector("a");
    expect(deployLink).not.toBeNull();
    expect(deployLink?.getAttribute("href")).toBe("/deploy");
    expect(deployLink?.textContent).toContain("添加到 Agent/项目");
    // 治理行上的主操作不是「添加到 Agent/项目」：动作词互不混用。
    expect(rowAction("managed:dep-eligible").textContent).toContain("纳入集中库管理");
    expect(rowAction("managed:dep-undeploy").textContent).toContain("从 Agent/项目移除");
  });
});

describe("RelationshipGovernancePage 单条治理", () => {
  it("runs single centralize as preview → confirm → run → verify → result", async () => {
    const { facade, tracker } = await renderGovernanceApp();
    await waitRows();

    fireEvent.click(rowAction("managed:dep-eligible"));

    // 预览：解释用户语义并加载影响事实（备份/共享影响/回退）。
    expect(await screen.findByRole("dialog", { name: "纳入集中库管理预览" })).toBeVisible();
    expect(screen.getByText(/保留当前位置的可用入口，改为使用集中库中的统一版本/)).toBeVisible();
    await screen.findByTestId("removal-impact-facts");

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "centralize_management",
      confirmations: {},
      relationIds: ["managed:dep-eligible"],
    }));
    await waitFor(() => expect(facade.commitGovernanceBatch).toHaveBeenCalledWith("batch-1", ["managed:dep-eligible"]));

    // 结果 + 校验：清单被重新读取以反映执行结果。
    await screen.findByText(/已纳入集中库管理/);
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
    await screen.findByRole("dialog", { name: "纳入集中库管理预览" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    // 预览保持打开：错误可见、没有成功文案、没有调用 commit。
    await screen.findByRole("alert");
    expect(screen.getByText(/预览保持不变/)).toBeVisible();
    expect(screen.queryByText(/已纳入集中库管理/)).not.toBeInTheDocument();
    expect(facade.commitGovernanceBatch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "纳入集中库管理预览" })).toBeVisible();
  });

  it("runs single undeploy through preview → confirm → run → result", async () => {
    const { facade, tracker } = await renderGovernanceApp();
    await waitRows();

    fireEvent.click(rowAction("managed:dep-undeploy"));
    expect(await screen.findByRole("dialog", { name: "从 Agent/项目移除预览" })).toBeVisible();
    await screen.findByTestId("removal-impact-facts");

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(facade.prepareRelationUndeploy).toHaveBeenCalledWith(MANAGED_ROW.relation));
    await waitFor(() => expect(facade.commitRelationUndeploy).toHaveBeenCalledWith("op-undeploy-1"));
    await screen.findByText(/已从目标移除/);
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledTimes(2));
    const undeployOp = tracker.getSnapshot().find((operation) => operation.kind === "undeploy");
    expect(undeployOp?.operationId).toBe("op-undeploy-1");
  });

  it("reports a single undeploy failure in the notification center with the inline description", async () => {
    // 用户裁决「写入失败也留痕」：单条解除部署关系失败必须同时进通知中心；
    // 通知详情与页面行内提示是同一份可读描述（带原始错误码，绝不 [object Object]）。
    const facade = createFacade(FULL_LEDGER, {
      commitRelationUndeploy: vi.fn().mockRejectedValue({ code: "io.denied" }),
    });
    const { tracker } = await renderGovernanceApp({ facade, notifications: true });
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
    await screen.findByRole("dialog", { name: "纳入集中库管理预览" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    const readable = "操作未能完成（io.denied）。若持续出现请记录该错误码。";
    const toast = await screen.findByTestId("notice-danger");
    expect(toast).toHaveTextContent(readable);
    // 既有行内契约不变：预览保持打开、错误可见、不翻成成功。
    expect(screen.getByText(/预览保持不变/)).toBeVisible();
    expect(facade.commitGovernanceBatch).not.toHaveBeenCalled();
  });

  it("locks only the busy relation and keeps other rows operable", async () => {
    await renderGovernanceApp();
    await waitRows();

    fireEvent.click(rowAction("managed:dep-eligible"));
    await screen.findByRole("dialog", { name: "纳入集中库管理预览" });

    // 同一条关系的按钮互斥（禁用），其他关系的按钮仍然可用。
    expect(rowAction("managed:dep-eligible")).toBeDisabled();
    expect(screen.getByTestId("governance-centralize-managed:dep-shared")).toBeEnabled();
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
    await screen.findByRole("dialog", { name: "纳入集中库管理预览" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    // 如实的失败终态：逐项失败信息 + 重试/回退入口。
    await screen.findByText("本次没有成功，请逐条查看失败原因");
    expect(screen.queryByText(/已纳入集中库管理：/)).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByTestId("governance-centralize-managed:dep-shared"));
    await screen.findByRole("dialog", { name: "纳入集中库管理预览" });

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
    fireEvent.click(screen.getByRole("button", { name: "批量纳入集中库管理" }));
    await screen.findByRole("dialog", { name: "批量纳入集中库管理" });
    return context;
  }

  it("select-all skips blocked rows by default and summarises executable/blocked counts", async () => {
    await renderGovernanceApp();
    await waitRows();

    fireEvent.click(screen.getByLabelText("全选本页关系"));

    // 受阻行默认不选中；其余行选中。
    expect(rowCheckbox("observed:agent.codex:broken").checked).toBe(false);
    expect(rowCheckbox("managed:dep-eligible").checked).toBe(true);
    expect(rowCheckbox("managed:dep-shared").checked).toBe(true);
    expect(rowCheckbox("managed:dep-undeploy").checked).toBe(true);

    // 汇总：可执行（可纳入 + 仅待共享确认）与受阻分开呈现。
    expect(screen.getByTestId("governance-batch-summary")).toHaveTextContent("可执行 2");
    expect(screen.getByTestId("governance-batch-summary")).toHaveTextContent("受阻 2");
  });

  it("lists non-executable items without selection in the dialog and cancels single items", async () => {
    const { facade } = await openBatchDialog();

    // 选中但不可批量执行的行在对话框中按受阻呈现：默认不选中且不可勾选。
    const staleItem = screen.getByTestId("governance-batch-item-observed:agent.codex:notes");
    expect(staleItem).toHaveTextContent("受阻");
    const staleCheckbox = screen.getByTestId("governance-batch-check-observed:agent.codex:notes") as HTMLInputElement;
    expect(staleCheckbox.checked).toBe(false);
    expect(staleCheckbox).toBeDisabled();

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
    expect(screen.queryByText(/已全部纳入集中库管理/)).not.toBeInTheDocument();
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

    await screen.findByText("已全部纳入集中库管理（2 条）");
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

  it("opens the governance preview for a deep-linked relationId", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance?from=conflict&conflictId=case-1&relationId=managed:dep-shared"],
    });
    await waitRows();
    expect(await screen.findByRole("dialog", { name: "纳入集中库管理预览" })).toBeVisible();
  });

  it("pushes committed filters into history so browser back restores the previous filter set", async () => {
    const { facade } = await renderGovernanceApp({
      entries: ["/agents/agent-a", "/relationships/governance?from=agent&agent=codex"],
      initialIndex: 1,
    });
    await waitRows();

    // 任务 11：已提交筛选写入历史。换桶后后退一步回到未筛选状态（bucket=all），
    // 再后退才离开治理页回 Agent 详情。
    fireEvent.click(screen.getByRole("button", { name: "受阻（1）" }));
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "blocked", agent_client_id: "codex" }),
    ));
    await screen.findByTestId("governance-row-list");

    fireEvent.click(screen.getByTestId("nav-back"));
    expect(await screen.findByTestId("governance-bucket-all")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(facade.listGovernance).toHaveBeenLastCalledWith(
      expect.objectContaining({ bucket: "all", agent_client_id: "codex" }),
    ));

    fireEvent.click(screen.getByTestId("nav-back"));
    expect(await screen.findByText("AGENT_ORIGIN")).toBeVisible();
  });

  it("restores selection, filters and scroll after leaving to a detail and returning", async () => {
    await renderGovernanceApp({
      entries: ["/relationships/governance", "/operations/op-1"],
    });
    await waitRows();

    fireEvent.click(rowCheckbox("managed:dep-eligible"));
    fireEvent.click(screen.getByRole("button", { name: "受阻（1）" }));
    // 等待换桶后的清单重新就绪，再在清单上留下滚动位置。
    await waitFor(() => expect(screen.getAllByTestId("governance-row")).toHaveLength(5));
    const list = screen.getByTestId("governance-row-list");
    list.scrollTop = 240;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByTestId("nav-depart"));
    expect(await screen.findByText("OPERATION_PAGE")).toBeVisible();

    fireEvent.click(screen.getByTestId("nav-back"));
    await waitRows();

    // 回到治理页：筛选、勾选与滚动位置都保留。
    expect(screen.getByRole("button", { name: "受阻（1）" })).toHaveAttribute("aria-pressed", "true");
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
};

describe("RelationshipGovernancePage 来源治理入口（任务 11）", () => {
  it("enters with the all bucket active from the sidebar and no import banner", async () => {
    const { facade } = await renderGovernanceApp();
    await waitRows();

    expect(screen.getByTestId("governance-bucket-all")).toHaveAttribute("aria-pressed", "true");
    expect(facade.listGovernance).toHaveBeenCalledWith(expect.objectContaining({ bucket: "all" }));
    expect(screen.queryByTestId("governance-import-banner")).not.toBeInTheDocument();
  });

  it("applies the import deep link to source copies, needs attention, and the batch, then announces the count", async () => {
    const ledger: RelationGovernanceLedger = {
      ...FULL_LEDGER,
      rows: [SOURCE_ROW],
      total: 1,
    };
    const { facade } = await renderGovernanceApp({
      entries: [
        "/relationships/governance?from=import&scope=source_copy&status=needs_attention&batch=import-b-9",
      ],
      facade: createFacade(ledger),
    });

    // 导入完成页深链直达“本次导入”的治理上下文：横幅宣布本地来源副本数。
    expect(await screen.findByTestId("governance-import-banner")).toHaveTextContent(
      "本次导入留下 1 个本地来源副本",
    );
    expect(facade.listGovernance).toHaveBeenCalledWith(expect.objectContaining({
      bucket: "all",
      statuses: ["needs_attention"],
      batch_id: "import-b-9",
    }));
    // scope 已按深链收紧：部署边不出现，对应 chips 处于激活态。
    expect(screen.queryByTestId("governance-select-managed:dep-eligible")).not.toBeInTheDocument();
    expect(screen.getByTestId("governance-scope-source_copy")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("governance-status-needs_attention")).toHaveAttribute("aria-pressed", "true");
    // 批次 id 只进 URL，不进页面文本。
    expect(screen.queryByText("import-b-9")).not.toBeInTheDocument();
  });

  it("filters by scope and the five statuses, keeps them in the URL, and restores on back", async () => {
    const ledger: RelationGovernanceLedger = {
      ...FULL_LEDGER,
      rows: [SOURCE_ROW, ELIGIBLE_ROW, MANAGED_ROW],
      total: 3,
    };
    const { facade } = await renderGovernanceApp({ facade: createFacade(ledger) });
    await waitRows();
    expect(screen.getAllByTestId("governance-row")).toHaveLength(3);

    // 五个快捷状态与三个 scope 全部可点；未选时不过滤。
    for (const status of ["normal", "retained", "needs_validation", "needs_attention", "blocked"]) {
      expect(screen.getByTestId(`governance-status-${status}`)).toBeVisible();
    }
    expect(screen.getByTestId("governance-scope-all")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("governance-status-needs_attention"));
    expect(await screen.findAllByTestId("governance-row")).toHaveLength(1);
    expect(facade.listGovernance).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: ["needs_attention"] }),
    );

    fireEvent.click(screen.getByTestId("governance-scope-source_copy"));
    expect(await screen.findAllByTestId("governance-row")).toHaveLength(1);
    expect(screen.getByTestId("location-search")).toHaveTextContent("status=needs_attention");
    expect(screen.getByTestId("location-search")).toHaveTextContent("scope=source_copy");

    // 浏览器后退恢复上一次已提交筛选：scope 回到 all，状态保持。
    fireEvent.click(screen.getByTestId("nav-back"));
    expect(await screen.findByTestId("governance-scope-all")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("governance-status-needs_attention")).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findAllByTestId("governance-row")).toHaveLength(1);
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
    await renderGovernanceApp({ facade: createFacade(ledger) });
    const rows = await screen.findAllByTestId("governance-row");
    expect(rows).toHaveLength(2);

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
  it("offers clean/retain by decision, gates unhealthy rows behind revalidate, and hides dangerous commits when blocked", async () => {
    const facade = createFacade(sourceLedger([
      PENDING_SOURCE_ROW,
      RETAINED_SOURCE_ROW,
      SOURCE_ROW,
      BLOCKED_SOURCE_ROW,
    ]));
    await renderGovernanceApp({ facade });
    expect((await screen.findAllByTestId("governance-row")).length).toBe(4);

    // Pending：清理与保留都可用。
    expect(screen.getByTestId("governance-clean-src-pending")).toBeEnabled();
    expect(screen.getByTestId("governance-retain-src-pending")).toBeEnabled();
    // Retained：仍可清理；保留入口不再提供。
    expect(screen.getByTestId("governance-clean-src-retained")).toBeEnabled();
    expect(screen.queryByTestId("governance-retain-src-retained")).not.toBeInTheDocument();
    // 待校验：清理/保留禁用（先校验），重新检查可用。
    expect(screen.getByTestId("governance-clean-src-import-1")).toBeDisabled();
    expect(screen.getByTestId("governance-retain-src-import-1")).toBeDisabled();
    expect(screen.getByTestId("governance-action-src-import-1")).toBeEnabled();
    // Blocked：不提供危险提交，只展示具体原因。
    expect(screen.queryByTestId("governance-clean-src-blocked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("governance-retain-src-blocked")).not.toBeInTheDocument();
    expect(screen.getByTestId("governance-blockers-src-blocked")).toBeVisible();
  });

  it("previews cleanup impact, requires ownership confirmation, then commits a single-item clean batch", async () => {
    const facade = createFacade(sourceLedger([PENDING_SOURCE_ROW]));
    await renderGovernanceApp({ facade });
    await screen.findByTestId("governance-clean-src-pending");

    fireEvent.click(screen.getByTestId("governance-clean-src-pending"));

    const preview = await screen.findByTestId("governance-clean-preview");
    expect(facade.getRelationshipRemovalImpact).toHaveBeenCalledWith("src-pending");
    // 影响预览明确：对象（Agent 徽标 + 路径）、原入口停止使用、集中库
    // 不受影响、可重新部署、备份/回滚。
    expect(preview.querySelector(".sh-agent-presentation")).not.toBeNull();
    expect(within(preview).getByText("C:\\agents\\codex\\skills\\pdf-reader")).toBeVisible();
    expect(within(preview).getByText("清理后，Agent 处的原入口将停止使用")).toBeVisible();
    expect(within(preview).getByText("集中库中的技能副本不受影响")).toBeVisible();
    expect(within(preview).getByText("以后可以把该技能重新部署到此 Agent")).toBeVisible();
    expect(within(preview).getByText("清理前会先创建备份，支持回滚")).toBeVisible();

    // 所有权确认是硬门槛：未勾选不能提交。
    const commit = within(preview).getByTestId("governance-clean-commit");
    expect(commit).toBeDisabled();
    fireEvent.click(within(preview).getByTestId("governance-clean-ownership"));
    expect(commit).toBeEnabled();
    fireEvent.click(commit);

    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "clean_source_copy",
      confirmations: { "src-pending": "shared_impact_confirmed" },
      relationIds: ["src-pending"],
    }));
    await waitFor(() => expect(facade.commitGovernanceBatch).toHaveBeenCalledTimes(1));
  });

  it("shows deploy-now/later actions after a committed cleanup without auto-committing a deployment", async () => {
    const facade = createFacade(sourceLedger([PENDING_SOURCE_ROW]), {
      commitGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
        action: "clean_source_copy",
        state: "committed",
        committed_count: 1,
        items: [batchItem({ relation_id: "src-pending", state: "committed" })],
        relationship_revision: "rev-9",
      })),
    });
    const { unmount } = await renderGovernanceApp({ facade });
    await screen.findByTestId("governance-clean-src-pending");

    fireEvent.click(screen.getByTestId("governance-clean-src-pending"));
    const preview = await screen.findByTestId("governance-clean-preview");
    fireEvent.click(within(preview).getByTestId("governance-clean-ownership"));
    fireEvent.click(within(preview).getByTestId("governance-clean-commit"));

    // 成功结果就地呈现，且给“部署到此 Agent”主入口和“稍后部署”。
    const result = await screen.findByTestId("governance-clean-result");
    expect(within(result).getByTestId("governance-clean-deploy")).toBeVisible();
    expect(within(result).getByTestId("governance-clean-later")).toBeVisible();

    // “稍后部署”只是关闭结果，不导航不提交。
    fireEvent.click(within(result).getByTestId("governance-clean-later"));
    expect(screen.queryByTestId("governance-clean-result")).not.toBeInTheDocument();
    expect(facade.commitGovernanceBatch).toHaveBeenCalledTimes(1);

    // 重新发起清理后再选“部署到此 Agent”：只打开目标可预选的部署页，
    // 绝不自动提交部署。
    fireEvent.click(screen.getByTestId("governance-clean-src-pending"));
    const previewAgain = await screen.findByTestId("governance-clean-preview");
    fireEvent.click(within(previewAgain).getByTestId("governance-clean-ownership"));
    fireEvent.click(within(previewAgain).getByTestId("governance-clean-commit"));
    await screen.findByTestId("governance-clean-result");
    const commitsBeforeDeploy = (facade.commitGovernanceBatch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByTestId("governance-clean-deploy"));
    expect(await screen.findByText("DEPLOY_PAGE")).toBeVisible();
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?skill=skill-pdf&agent=codex",
    );
    // 部署入口只是导航：治理批次提交次数不因它变化。
    expect(facade.commitGovernanceBatch).toHaveBeenCalledTimes(commitsBeforeDeploy);
    unmount();
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
    await renderGovernanceApp({ facade });
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

  it("batch-cleans healthy source copies behind one ownership confirmation", async () => {
    const ledger = sourceLedger([PENDING_SOURCE_ROW, RETAINED_SOURCE_ROW, SOURCE_ROW]);
    const facade = createFacade(ledger);
    await renderGovernanceApp({ facade });
    expect((await screen.findAllByTestId("governance-row")).length).toBe(3);

    fireEvent.click(screen.getByTestId("governance-select-src-pending"));
    fireEvent.click(screen.getByTestId("governance-select-src-retained"));
    fireEvent.click(screen.getByTestId("governance-select-src-import-1"));
    fireEvent.click(screen.getByTestId("governance-open-batch"));

    const dialog = await screen.findByTestId("governance-batch-dialog");
    // 待校验的来源副本进入受阻组（先校验），不可执行。
    expect(within(dialog).getByTestId("governance-batch-check-src-import-1")).toBeDisabled();
    // 所有权确认是批量清理的硬门槛。
    const confirm = within(dialog).getByTestId("governance-batch-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("governance-batch-ownership"));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      action: "clean_source_copy",
      confirmations: {
        "src-pending": "shared_impact_confirmed",
        "src-retained": "shared_impact_confirmed",
      },
      relationIds: ["src-pending", "src-retained"],
    }));
  });
});

// —— 11.16：清理失败保留当前行，Revalidate/Retry/Restore 全部可用 ——

describe("RelationshipGovernancePage 清理失败（任务 11.16）", () => {
  it("keeps the row and offers retry/rollback when the clean batch fails", async () => {
    const facade = createFacade(sourceLedger([PENDING_SOURCE_ROW, SOURCE_ROW]), {
      commitGovernanceBatch: vi.fn().mockResolvedValue(batchOutcome({
        action: "clean_source_copy",
        state: "failed",
        failed_count: 1,
        items: [batchItem({
          relation_id: "src-pending",
          state: "failed",
          error_code: "internal.error",
          detail: "permission denied",
          retryable: true,
          rollback_available: true,
        })],
      })),
    });
    const { unmount } = await renderGovernanceApp({ facade });
    await screen.findByTestId("governance-clean-src-pending");

    fireEvent.click(screen.getByTestId("governance-clean-src-pending"));
    const preview = await screen.findByTestId("governance-clean-preview");
    fireEvent.click(within(preview).getByTestId("governance-clean-ownership"));
    fireEvent.click(within(preview).getByTestId("governance-clean-commit"));

    // 失败结论就地呈现：逐项结果面板如实显示失败与原因，不冒充成功。
    const result = await screen.findByTestId("governance-batch-result");
    expect(result).toHaveTextContent("permission denied");
    expect(within(result).getByTestId("governance-batch-retry-src-pending")).toBeVisible();
    // 行没有被本地假删：清单里仍可见，其他行的重新检查仍可用；
    // 该行按钮因自身预览打开而互斥锁定，属预期。
    expect(screen.getByTestId("governance-source-src-pending")).toBeVisible();
    expect(screen.getByTestId("governance-action-src-import-1")).toBeEnabled();
    unmount();
  });
});
