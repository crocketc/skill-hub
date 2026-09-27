import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication, type WorkItem } from "../../api/bindings";
import { nativePendingFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ queryApplication: vi.fn(), executeCommand: vi.fn() }));
const work = (kind: WorkItem["kind"], subject: string): WorkItem => ({
  id: `work:${kind}:${subject}:v1`, kind, subject, display_name: "Notes", message_code: `pending.reasons.${kind}`,
  recommended: false, can_confirm: false, can_defer: kind === "trial_due", can_ignore: kind === "trial_due", version_id: null,
  finding_id: null, check_kind: null, path: null, due_date: null, risk: null, source_roots: [],
});
let items: WorkItem[];
let unavailable: string[];
beforeEach(() => {
  vi.clearAllMocks(); unavailable = [];
  items = [work("trial_due", "skill-a"), work("security_finding", "skill-a"), work("conflict", "case-a"), work("governance", "relation-a"), work("recovery", "op-a")];
  vi.mocked(queryApplication).mockImplementation(async () => ({ type: "pending_workspace", payload: { items, unavailable_sources: unavailable } }));
});

it("reads one authoritative query and gives all five sources exact destinations", async () => {
  const result = await nativePendingFacade.list();
  expect(result).toHaveLength(5);
  expect(queryApplication).toHaveBeenCalledExactlyOnceWith({ type: "get_pending_workspace" });
  expect(result.find((item) => item.kind === "conflict")).toMatchObject({ displayName: "Notes", href: "/relationships/decisions?conflictId=case-a", canSnooze: false });
  expect(result.find((item) => item.kind === "governance")?.href).toContain("relationId=relation-a");
  expect(result.find((item) => item.kind === "recovery")).toMatchObject({ href: "/recovery?operationId=op-a", canSnooze: false });
});
it("removes items when the next domain projection reports completion", async () => {
  expect(await nativePendingFacade.list()).toHaveLength(5);
  items = items.filter((item) => ["trial_due", "security_finding"].includes(item.kind));
  expect((await nativePendingFacade.list()).map((item) => item.kind)).toEqual(["trial_due", "security_finding"]);
});
it("exposes unavailable sources without discarding successful groups", async () => {
  unavailable = ["governance"];
  const result = await nativePendingFacade.workspace!();
  expect(result.unavailableSources).toEqual(["governance"]);
  expect(result.items).toHaveLength(5);
});
it("does not let generic ignore or defer hide a required recovery or security finding", async () => {
  for (const item of (await nativePendingFacade.list()).filter((item) => ["recovery", "security_finding"].includes(item.kind))) {
    await expect(nativePendingFacade.ignore([item], "later")).rejects.toThrow();
    await expect(nativePendingFacade.defer([item], 7, "later")).rejects.toThrow();
  }
  expect(executeCommand).not.toHaveBeenCalled();
});
