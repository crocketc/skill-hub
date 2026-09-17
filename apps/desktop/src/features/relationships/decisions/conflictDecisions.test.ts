import { describe, expect, it } from "vitest";
import {
  allConflictScope,
  caseConflictScope,
  categoryConflictScope,
  conflictGovernanceHref,
  conflictKindGroup,
  conflictWorkspaceHref,
  nextConflictId,
} from "./conflictDecisions";

describe("conflict decision helpers", () => {
  it("builds the frozen governance handoff href with conflict context", () => {
    expect(conflictGovernanceHref({ conflictId: "conflict:a" })).toBe(
      "/relationships/governance?from=conflict&conflictId=conflict:a",
    );
  });

  it("carries the relation id only when a relation edge is actually known", () => {
    expect(
      conflictGovernanceHref({ conflictId: "conflict:a", relationId: "rel:9" }),
    ).toBe("/relationships/governance?from=conflict&conflictId=conflict:a&relationId=rel:9");
    // 工作台 DTO 没有关系边时不得伪造 relationId（后端契约注释明确禁止）。
    expect(
      conflictGovernanceHref({ conflictId: "conflict:a", relationId: null }),
    ).toBe("/relationships/governance?from=conflict&conflictId=conflict:a");
  });

  it("builds workspace deep links for the legacy panels", () => {
    expect(conflictWorkspaceHref()).toBe("/relationships/decisions");
    expect(conflictWorkspaceHref("conflict:a")).toBe(
      "/relationships/decisions?conflictId=conflict:a",
    );
  });

  it("maps the three AI scopes to the AnalyzeConflict payloads", () => {
    expect(allConflictScope()).toEqual({ type: "all" });
    expect(categoryConflictScope("uncertain")).toEqual({
      type: "category",
      value: { classification: "uncertain" },
    });
    expect(caseConflictScope("conflict:a")).toEqual({
      type: "case",
      value: { conflict_id: "conflict:a" },
    });
  });

  it("groups queue cases by conflict kind and walks prev/next within the queue", () => {
    const queue = [
      { case: { conflict_id: "conflict:a", kind: "same_name_different_content" } },
      { case: { conflict_id: "conflict:b", kind: "duplicate_same_content" } },
      { case: { conflict_id: "conflict:c", kind: "same_name_different_content" } },
      { case: { conflict_id: "conflict:d" } },
    ] as const;

    expect(conflictKindGroup(queue[0])).toBe("same_name_different_content");
    // kind 缺省按「其他冲突」归组，不冒充分类事实。
    expect(conflictKindGroup(queue[3])).toBe("unknown");
    expect(nextConflictId(queue, null, "next")).toBe("conflict:a");
    expect(nextConflictId(queue, "conflict:b", "next")).toBe("conflict:c");
    expect(nextConflictId(queue, "conflict:d", "next")).toBeNull();
    expect(nextConflictId(queue, "conflict:c", "prev")).toBe("conflict:b");
    expect(nextConflictId(queue, "conflict:a", "prev")).toBeNull();
    expect(nextConflictId([], null, "next")).toBeNull();
  });
});
