import { vi } from "vitest";

// 只 mock queryApplication 本体；断言查询类型/载荷与结果守卫行为。
const queryApplicationMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/bindings", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../api/bindings")
  >()),
  queryApplication: queryApplicationMock,
}));

const { nativeRelationshipsFacade } = await import("./nativeApi");

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
});
