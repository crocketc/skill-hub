import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
} from "../../../api/bindings";
import { createOperationTracker, type OperationTracker } from "../../../platform/operationTracker";
import { createSkillHubI18n } from "../../../i18n";
import { RelationshipsGovernancePage } from "../RelationshipsPages";
import {
  RelationshipGovernancePage,
  type RelationGovernanceFacade,
} from "./RelationshipGovernancePage";

vi.mock("./nativeApi", () => ({ nativeGovernanceFacade: { __mocked: true } }));

afterEach(() => {
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

interface RowSpec {
  relationId: string;
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
    relation: relationFact({
      relation_id: spec.relationId,
      skill_id: spec.skillId === undefined ? "skill-pdf" : spec.skillId,
      agent_client_id: spec.agentClientId ?? "codex",
      path: spec.path ?? "C:/agents/codex/skills/pdf-reader",
      relationship: spec.relationship ?? "managed_copy",
      ownership: spec.ownership ?? "skillhub_managed",
    }),
    skill_display_name: spec.displayName ?? null,
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
  counts: { all: 5, eligible_to_centralize: 1, needs_validation: 2, blocked: 1 },
  bucket: "all",
  total: 5,
  relationship_revision: "rev-1",
  last_verified_at: "2026-09-17T08:00:00Z",
};

function removalImpactFact(): RemovalImpactFact {
  return {
    relation_id: ELIGIBLE_ROW.relation.relation_id,
    relation: ELIGIBLE_ROW.relation,
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
    relation_id: ELIGIBLE_ROW.relation.relation_id,
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
      relationId: MANAGED_ROW.relation.relation_id,
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
  } = options;
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
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
        </MemoryRouter>
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
    expect(screen.getByText("C:/agents/codex/skills/link-reader")).toBeVisible();

    expect(screen.getByTestId("governance-header-relation")).toHaveTextContent("关系");
    expect(screen.getByTestId("governance-header-source")).toHaveTextContent("来源");
    expect(screen.getByTestId("governance-header-target")).toHaveTextContent("目标");
    expect(screen.getByTestId("governance-header-impact")).toHaveTextContent("影响");
    expect(screen.getByTestId("governance-source-managed:dep-eligible")).toHaveTextContent("导入登记");
    expect(screen.getByTestId("governance-target-managed:dep-eligible")).toHaveTextContent("codex");
    // 影响列展示其他共享消费者。
    expect(screen.getByTestId("governance-impact-managed:dep-shared")).toHaveTextContent("cursor");
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

    await waitFor(() => expect(facade.prepareRelationUndeploy).toHaveBeenCalledWith("managed:dep-undeploy"));
    await waitFor(() => expect(facade.commitRelationUndeploy).toHaveBeenCalledWith("op-undeploy-1"));
    await screen.findByText(/已从目标移除/);
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledTimes(2));
    const undeployOp = tracker.getSnapshot().find((operation) => operation.kind === "undeploy");
    expect(undeployOp?.operationId).toBe("op-undeploy-1");
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
      confirmations: { "managed:dep-shared": expect.any(String) },
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

    fireEvent.click(screen.getByLabelText("我已确认共享目录影响（managed:dep-shared）"));
    fireEvent.click(screen.getByRole("button", { name: "确认执行 2 条" }));

    await waitFor(() => expect(facade.prepareGovernanceBatch).toHaveBeenCalledWith({
      confirmations: { "managed:dep-shared": expect.any(String) },
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

    fireEvent.click(screen.getByLabelText("我已确认共享目录影响（managed:dep-shared）"));
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

    fireEvent.click(screen.getByLabelText("我已确认共享目录影响（managed:dep-shared）"));
    fireEvent.click(screen.getByRole("button", { name: "确认执行 2 条" }));
    await screen.findByText("部分成功：1 条成功，1 条失败");

    fireEvent.click(screen.getByRole("button", { name: "重试 managed:dep-shared" }));

    await screen.findByText("已全部纳入集中库管理（2 条）");
    expect(facade.prepareGovernanceBatch).toHaveBeenLastCalledWith({
      confirmations: { "managed:dep-shared": expect.any(String) },
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

  it("replaces filter browsing in history so browser back exits to the origin", async () => {
    const { facade } = await renderGovernanceApp({
      entries: ["/agents/agent-a", "/relationships/governance?from=agent&agent=codex"],
      initialIndex: 1,
    });
    await waitRows();

    // 筛选浏览必须 replace：后退一步直达 Agent 详情，而不是回到未筛选的治理页。
    fireEvent.click(screen.getByRole("button", { name: "受阻（1）" }));
    await waitFor(() => expect(facade.listGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "blocked", agent_client_id: "codex" }),
    ));
    await screen.findByTestId("governance-row-list");

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
