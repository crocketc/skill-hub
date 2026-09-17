import { describe, expect, it } from "vitest";
import { relationshipsKeys } from "./api";

describe("relationships query keys", () => {
  it("namespaces every key under the relationships root", () => {
    expect(relationshipsKeys.root).toEqual(["relationships"]);
  });

  it("carries skillId, filters and relationship_revision in the graph key", () => {
    expect(
      relationshipsKeys.graph({
        skillId: "pdf-reader",
        relationshipTypes: ["shared_directory_read"],
        statuses: ["active"],
        relationshipRevision: "r42",
      }),
    ).toEqual([
      ["relationships"],
      "graph",
      {
        skillId: "pdf-reader",
        relationshipTypes: ["shared_directory_read"],
        statuses: ["active"],
        relationshipRevision: "r42",
      },
    ]);
  });

  it("keeps committed governance filters and conflict/candidate params in their keys", () => {
    expect(
      relationshipsKeys.governance({
        bucket: "needs_validation",
        skill_id: "pdf-reader",
        relationshipRevision: "r42",
      }),
    ).toEqual([
      ["relationships"],
      "governance",
      { bucket: "needs_validation", skill_id: "pdf-reader", relationshipRevision: "r42" },
    ]);
    expect(relationshipsKeys.conflicts({ relationshipRevision: "r42" })).toEqual([
      ["relationships"],
      "conflicts",
      { relationshipRevision: "r42" },
    ]);
    expect(relationshipsKeys.candidates({ text: "pdf" })).toEqual([
      ["relationships"],
      "candidates",
      { text: "pdf" },
    ]);
  });
});
