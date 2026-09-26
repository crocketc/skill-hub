import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativePendingFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ queryApplication: vi.fn(), executeCommand: vi.fn() }));

const governanceRow = (id: string, status = "needs_validation") => ({
  relation: { kind: "source_copy", fact: { relation_id: id, skill_id: "skill-a", active: true, source_path: "C:/fixtures/notes" } },
  status, skill_display_name: "Notes", blockers: [],
});

let facts: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  facts = {
    list_pending_items: { type: "pending_items", payload: [
      { kind: "trial_due", subject: "skill-a", code: "trial.due" },
      { kind: "security_finding", subject: "skill-a", code: "warning", risk: "medium" },
    ] },
    get_conflict_workspace: { type: "conflict_workspace", payload: { cases: [
      { case: { conflict_id: "case-a", member_skill_ids: ["skill-a", "skill-b"] } },
    ], handled: [{ conflict_id: "handled" }] } },
    list_relation_governance: { type: "relation_governance_ledger", payload: { rows: [
      governanceRow("relation-a"), governanceRow("relation-a"), governanceRow("normal", "normal"), governanceRow("retained", "retained"),
    ] } },
    list_recovery_candidates: { type: "recovery_candidates", payload: [{ operation_id: "op-a", actions: ["rollback_operation"] }] },
    get_skill: { type: "skill", payload: { display_name: "Notes" } },
  };
  vi.mocked(queryApplication).mockImplementation(async (request) => facts[request.type] as never);
});

it("collects all five actionable sources, deduplicates relations, and gives exact destinations", async () => {
  const items = await nativePendingFacade.list();
  expect(items).toHaveLength(5);
  expect(new Set(items.map((item) => item.kind))).toEqual(new Set(["trial_due", "security_finding", "conflict", "governance", "recovery"]));
  expect(items.find((item) => item.kind === "conflict")).toMatchObject({ displayName: "Notes", href: "/relationships/decisions?conflictId=case-a", canSnooze: false });
  expect(items.find((item) => item.kind === "governance")?.href).toContain("relationId=relation-a");
  expect(items.find((item) => item.kind === "recovery")).toMatchObject({ href: "/recovery?operationId=op-a", canSnooze: false });
  expect(items.find((item) => item.kind === "trial_due")?.displayName).toBe("Notes");
});

it("removes completed conflicts, governed relations and recovered operations on the next read", async () => {
  expect(await nativePendingFacade.list()).toHaveLength(5);
  facts.get_conflict_workspace = { type: "conflict_workspace", payload: { cases: [] } };
  facts.list_relation_governance = { type: "relation_governance_ledger", payload: { rows: [governanceRow("relation-a", "normal")] } };
  facts.list_recovery_candidates = { type: "recovery_candidates", payload: [] };
  expect((await nativePendingFacade.list()).map((item) => item.kind).sort()).toEqual(["security_finding", "trial_due"]);
});

it("does not claim an empty inbox when an actionable source fails", async () => {
  vi.mocked(queryApplication).mockImplementation(async (request) => {
    if (request.type === "list_relation_governance") throw new Error("offline");
    return facts[request.type] as never;
  });
  await expect(nativePendingFacade.list()).rejects.toThrow("offline");
});

it("does not let generic ignore or defer hide a required recovery", async () => {
  const recovery = (await nativePendingFacade.list()).find((item) => item.kind === "recovery")!;
  expect(recovery).toBeDefined();
  await expect(nativePendingFacade.ignore([recovery], "later")).rejects.toThrow();
  await expect(nativePendingFacade.defer([recovery], 7, "later")).rejects.toThrow();
  expect(executeCommand).not.toHaveBeenCalled();
});
