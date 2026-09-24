import { describe, expect, it } from "vitest";
import { parseGovernanceSearchParams } from "./governance/api";
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

// 计划 9.5：治理页 URL 支持来源深链、行类别、行状态与批次过滤；
// 未知值 fail-safe 回退为不过滤，绝不让过期 URL 制造查询错误。
describe("governance deep link params", () => {
  it("parses import source, source-copy scope, status and batch filters", () => {
    const params = new URLSearchParams(
      "from=import&scope=source_copy&status=needs_attention&batch=batch-42",
    );
    expect(parseGovernanceSearchParams(params)).toEqual(
      expect.objectContaining({
        from: "import",
        scope: "source_copy",
        status: "needs_attention",
        batchId: "batch-42",
      }),
    );
  });

  it("falls back to unfiltered values for unknown or missing params", () => {
    const params = new URLSearchParams(
      "from=malware&scope=kernel&status=exploded&bucket=everything",
    );
    const link = parseGovernanceSearchParams(params);
    expect(link.from).toBeNull();
    expect(link.scope).toBe("all");
    expect(link.status).toBeNull();
    expect(link.bucket).toBe("all");
    expect(link.batchId).toBeNull();
  });

  it("keeps deployment scope parseable and defaults scope to all", () => {
    expect(parseGovernanceSearchParams(new URLSearchParams("scope=deployment")).scope).toBe(
      "deployment",
    );
    expect(parseGovernanceSearchParams(new URLSearchParams()).scope).toBe("all");
    expect(parseGovernanceSearchParams(new URLSearchParams()).status).toBeNull();
  });
});
