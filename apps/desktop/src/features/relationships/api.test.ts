import { describe, expect, it } from "vitest";
import { parseGovernanceSearchParams } from "./governance/api";
import { relationshipsKeys } from "./api";

describe("relationships query keys", () => {
  it("namespaces every key under the relationships root", () => {
    expect(relationshipsKeys.root).toEqual(["relationships"]);
    expect(relationshipsKeys.governanceUsageOverview()).toEqual([
      relationshipsKeys.root,
      "governance-usage-overview",
    ]);
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

// 计划 9.5 + 12.6：治理页 URL 支持来源深链、行类别、行状态与批次过滤；
describe("governance deep link params", () => {
  it("parses governance classification and management independently from scope", () => {
    const params = new URLSearchParams(
      "from=import&scope=source_copy&governance=pending&management=taken_over&batch=batch-42",
    );
    expect(parseGovernanceSearchParams(params)).toEqual(
      expect.objectContaining({
        from: "import",
        scope: "source_copy",
        classification: "pending",
        management: "taken_over",
        batchId: "batch-42",
      }),
    );
  });

  it("fails safe for unknown classifications and management filters", () => {
    const link = parseGovernanceSearchParams(new URLSearchParams(
      "governance=exploded&management=all&bucket=blocked&status=blocked",
    ));
    // W2-3（§10）：页签默认「待处理」，未知分类安全回退到 pending。
    expect(link.classification).toBe("pending");
    expect(link.management).toBeNull();
  });

  it("falls back to unfiltered values for unknown or missing params", () => {
    const params = new URLSearchParams(
      "from=malware&scope=kernel&governance=exploded&management=exploded",
    );
    const link = parseGovernanceSearchParams(params);
    expect(link.from).toBeNull();
    expect(link.scope).toBe("all");
    // W2-3（§10）：页签默认「待处理」。
    expect(link.classification).toBe("pending");
    expect(link.management).toBeNull();
    expect(link.batchId).toBeNull();
  });

  it("maps saved completed URLs to the no-action tab", () => {
    expect(parseGovernanceSearchParams(new URLSearchParams("governance=completed")).classification)
      .toBe("no_action");
    expect(parseGovernanceSearchParams(new URLSearchParams("governance=no_action")).classification)
      .toBe("no_action");
  });

  it("keeps deployment scope parseable and defaults scope to all", () => {
    expect(parseGovernanceSearchParams(new URLSearchParams("scope=deployment")).scope).toBe(
      "deployment",
    );
    expect(parseGovernanceSearchParams(new URLSearchParams()).scope).toBe("all");
    expect(parseGovernanceSearchParams(new URLSearchParams()).classification).toBe("pending");
    expect(parseGovernanceSearchParams(new URLSearchParams()).management).toBeNull();
  });
});
