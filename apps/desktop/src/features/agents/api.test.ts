import { expect, it } from "vitest";
import { sharedTargetFixture, unavailableAgentFacade } from "./api";

it("keeps production Agent queries unavailable", async () => {
  await expect(unavailableAgentFacade.list()).rejects.toThrow("unavailable");
});

it("represents two logical clients on one physical target", () => {
  const view = sharedTargetFixture();
  expect(view.relations.map((relation) => relation.logicalTargetId)).toHaveLength(2);
  expect(new Set(view.relations.map((relation) => relation.physicalTargetId)).size).toBe(1);
});
