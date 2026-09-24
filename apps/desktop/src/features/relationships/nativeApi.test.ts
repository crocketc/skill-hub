import { describe, expect, it, vi } from "vitest";

// 只 mock queryApplication 本体；断言查询类型/载荷与结果守卫行为。
const queryApplicationMock = vi.hoisted(() => vi.fn());
const executeCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/bindings", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../api/bindings")
  >()),
  queryApplication: queryApplicationMock,
  executeCommand: executeCommandMock,
}));

const { nativeRelationshipsFacade } = await import("./nativeApi");
const { nativeGovernanceFacade } = await import("./governance/nativeApi");

describe("nativeRelationshipsFacade", () => {
  it("reads the skill relationship graph with explicit skill and filters", async () => {
    const graph = { center_skill_id: "pdf-reader", nodes: [], edges: [] };
    queryApplicationMock.mockResolvedValueOnce({
      type: "skill_relationship_graph",
      payload: graph,
    });

    await expect(
      nativeRelationshipsFacade.getGraph({
        skillId: "pdf-reader",
        relationshipTypes: ["shared_directory_read"],
        statuses: ["active"],
      }),
    ).resolves.toBe(graph);

    expect(queryApplicationMock).toHaveBeenCalledWith({
      type: "get_skill_relationship_graph",
      payload: {
        skill_id: "pdf-reader",
        filters: { relationship_types: ["shared_directory_read"], statuses: ["active"] },
      },
    });
  });

  it("throws an unexpected-result error when the graph query answers with another type", async () => {
    queryApplicationMock.mockResolvedValueOnce({ type: "bootstrap_snapshot", payload: {} });
    await expect(nativeRelationshipsFacade.getGraph({ skillId: "pdf-reader" })).rejects.toThrow(
      "get_skill_relationship_graph returned an unexpected native result.",
    );
  });

  it("lists relationship candidates and guards the result type", async () => {
    const candidates = [{ skill_id: "pdf-reader" }];
    queryApplicationMock.mockResolvedValueOnce({
      type: "skill_relationship_candidates",
      payload: candidates,
    });
    await expect(nativeRelationshipsFacade.listCandidates({ text: "pdf" })).resolves.toBe(
      candidates,
    );
    expect(queryApplicationMock).toHaveBeenCalledWith({
      type: "list_skill_relationship_candidates",
      payload: { text: "pdf" },
    });

    queryApplicationMock.mockResolvedValueOnce({ type: "pending_items", payload: [] });
    await expect(nativeRelationshipsFacade.listCandidates()).rejects.toThrow(
      "list_skill_relationship_candidates returned an unexpected native result.",
    );
  });

  it("reads the conflict workspace without filters and guards the result type", async () => {
    const workspace = { cases: [], handled_count: 3 };
    queryApplicationMock.mockResolvedValueOnce({
      type: "conflict_workspace",
      payload: workspace,
    });
    await expect(nativeRelationshipsFacade.getConflictWorkspace()).resolves.toBe(workspace);
    expect(queryApplicationMock).toHaveBeenCalledWith({
      type: "get_conflict_workspace",
      payload: null,
    });

    queryApplicationMock.mockResolvedValueOnce({ type: "pending_items", payload: [] });
    await expect(nativeRelationshipsFacade.getConflictWorkspace()).rejects.toThrow(
      "get_conflict_workspace returned an unexpected native result.",
    );
  });

  it("lists the governance ledger with committed filters only (revision stays client-side)", async () => {
    const ledger = { rows: [], counts: {}, total: 0 };
    queryApplicationMock.mockResolvedValueOnce({
      type: "relation_governance_ledger",
      payload: ledger,
    });

    await expect(
      nativeRelationshipsFacade.listGovernance({
        bucket: "needs_validation",
        relationshipRevision: "r42",
      }),
    ).resolves.toBe(ledger);

    expect(queryApplicationMock).toHaveBeenCalledWith({
      type: "list_relation_governance",
      payload: { filters: { bucket: "needs_validation" } },
    });

    queryApplicationMock.mockResolvedValueOnce({ type: "pending_items", payload: [] });
    await expect(nativeRelationshipsFacade.listGovernance()).rejects.toThrow(
      "list_relation_governance returned an unexpected native result.",
    );
  });

  // 计划 9.4：批次/来源类别/状态等已提交筛选必须原样透传给原生清单查询，
  // 门面不得丢弃、改写或二次猜测。
  it("passes scope/status/batch filters straight through to the governance query", async () => {
    const ledger = { rows: [], counts: {}, total: 0 };
    queryApplicationMock.mockResolvedValueOnce({
      type: "relation_governance_ledger",
      payload: ledger,
    });

    const filters = {
      bucket: "all" as const,
      source_class: "agent_local" as const,
      statuses: ["needs_attention" as const],
      batch_id: "batch-42",
    };
    await expect(
      nativeRelationshipsFacade.listGovernance({ ...filters, relationshipRevision: "r7" }),
    ).resolves.toBe(ledger);
    expect(queryApplicationMock).toHaveBeenCalledWith({
      type: "list_relation_governance",
      payload: { filters },
    });
  });

  // 计划 9.4：revalidate 是 RunRelationshipCheck 命令（事实落库），不是
  // 再查一次清单；RelationIds scope 由 facade 组装。
  it("revalidates through the relationship check command instead of re-querying", async () => {
    const report = { items: [], relationship_revision: "9" };
    executeCommandMock.mockResolvedValueOnce({
      type: "relationship_check_report",
      payload: report,
    });

    await expect(
      nativeGovernanceFacade.revalidate(["rel-1", "rel-2"], "light"),
    ).resolves.toBe(report);
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: "run_relationship_check",
      payload: {
        level: "light",
        scope: { relation_ids: { relation_ids: ["rel-1", "rel-2"] } },
      },
    });

    // 缺省级别是 Full（完整核验）；空集合回退为全量活动关系。
    executeCommandMock.mockResolvedValueOnce({
      type: "relationship_check_report",
      payload: report,
    });
    await nativeGovernanceFacade.revalidate([]);
    expect(executeCommandMock).toHaveBeenLastCalledWith({
      type: "run_relationship_check",
      payload: { level: "full", scope: "all_active" },
    });
  });

  // 计划 9.4：治理历史是独立分页查询（写入时固化的显示快照），与通用
  // 清单完全分离。
  it("reads governance history through its dedicated paged query", async () => {
    const page = { items: [], total: 2, page: 1, page_size: 50 };
    queryApplicationMock.mockResolvedValueOnce({
      type: "governance_history_page",
      payload: page,
    });

    await expect(
      nativeGovernanceFacade.listHistory({ relationId: "rel-9", pageSize: 50 }),
    ).resolves.toBe(page);
    expect(queryApplicationMock).toHaveBeenCalledWith({
      type: "list_governance_history",
      payload: {
        page: undefined,
        page_size: 50,
        relation_id: "rel-9",
        skill_id: null,
        agent_client_id: null,
        project_id: null,
        result: null,
      },
    });

    queryApplicationMock.mockResolvedValueOnce({ type: "pending_items", payload: [] });
    await expect(nativeGovernanceFacade.listHistory({})).rejects.toThrow(
      "list_governance_history returned an unexpected native result.",
    );
  });

  // 计划 8.15：保留/重关联走各自的单条命令，结果守卫到关系事实。
  it("retains and relinks source copies through their dedicated commands", async () => {
    const fact = { relation_id: "rel-keep", active: true };
    executeCommandMock.mockResolvedValueOnce({
      type: "source_copy_relation_updated",
      payload: fact,
    });
    await expect(nativeGovernanceFacade.retainSourceCopy("rel-keep")).resolves.toBe(fact);
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: "retain_source_copy",
      payload: { source_relation_id: "rel-keep" },
    });

    executeCommandMock.mockResolvedValueOnce({
      type: "source_copy_relation_updated",
      payload: fact,
    });
    await expect(
      nativeGovernanceFacade.relinkSourceCopy("rel-keep", "C:/restored"),
    ).resolves.toBe(fact);
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: "relink_source_copy",
      payload: { source_relation_id: "rel-keep", new_source_path: "C:/restored" },
    });

    executeCommandMock.mockResolvedValueOnce({ type: "operation_summary", payload: {} as never });
    await expect(nativeGovernanceFacade.retainSourceCopy("rel-keep")).rejects.toThrow(
      "retain_source_copy returned an unexpected native result.",
    );
  });

  // 计划 8.16：批次动作透传——来源副本批次不再硬编码部署转换动作。
  it("passes the batch action through when preparing a governance batch", async () => {
    const outcome = { batch_id: "batch-1", items: [], state: "prepared" };
    executeCommandMock.mockResolvedValueOnce({
      type: "relation_governance_batch",
      payload: outcome,
    });

    await expect(
      nativeGovernanceFacade.prepareGovernanceBatch({
        action: "clean_source_copy",
        relationIds: ["rel-1"],
        confirmations: { "rel-1": "confirmed" },
      }),
    ).resolves.toBe(outcome);
    expect(executeCommandMock).toHaveBeenCalledWith({
      type: "prepare_relation_governance_batch",
      payload: {
        action: "clean_source_copy",
        relation_ids: ["rel-1"],
        confirmations: { "rel-1": "confirmed" },
      },
    });
  });
});
