import { describe, expect, it, vi } from "vitest";
import {
  createMockImportFacade,
  parseSourceInput,
  unavailableImportFacade,
} from "./api";

describe("ImportFacade contract", () => {
  it("parses npx text as a non-executable reference", async () => {
    const source = await parseSourceInput("npx skills add github:owner/repo");

    expect(source).toEqual(
      expect.objectContaining({
        kind: "npx_reference",
        displayTarget: "github:owner/repo",
        executesCommand: false,
      }),
    );
  });

  it("classifies canonical GitHub repository URLs as Git sources", async () => {
    await expect(parseSourceInput("https://github.com/owner/repo")).resolves.toEqual(
      expect.objectContaining({ kind: "git", displayTarget: "https://github.com/owner/repo" }),
    );
  });

  it("rejects acquisition and commit at the production boundary", async () => {
    const source = await unavailableImportFacade.parseSource("C:\\Skills\\pdf");

    await expect(unavailableImportFacade.acquireCandidates(source)).rejects.toThrow(
      "import is unavailable",
    );
    await expect(
      unavailableImportFacade.commitImport(
        { candidates: [], conflicts: [] },
        {},
      ),
    ).rejects.toThrow("import is unavailable");
  });

  it("returns deterministic Agent ownership and partial commit fixtures", async () => {
    const facade = createMockImportFacade({ scenario: "agent-owned-partial" });
    const source = await facade.parseSource("C:\\Agents\\codex\\skills");
    const candidates = await facade.acquireCandidates(source);
    const plan = await facade.analyzeConflicts(candidates);
    const results = await facade.commitImport(plan, {
      [candidates[0].id]: "takeover",
      [candidates[1].id]: "skip",
    });

    expect(candidates[0].ownership).toBe("agent_builtin");
    expect(results.map((result) => result.status)).toEqual([
      "succeeded",
      "skipped",
    ]);
  });

  it("reports per-candidate analysis progress while staying backward compatible", async () => {
    const facade = createMockImportFacade({ scenario: "safe-local" });
    const source = await facade.parseSource("C:\\Skills\\pdf");
    const candidates = await facade.acquireCandidates(source);
    const onProgress = vi.fn();

    const plan = await facade.analyzeConflicts(candidates, onProgress);

    // 进度契约与提交一致：{ candidateId, completed, total }，总数即候选数。
    expect(onProgress).toHaveBeenLastCalledWith({
      candidateId: candidates[1].id,
      completed: 2,
      total: 2,
    });
    expect(plan.candidates).toHaveLength(2);
    // 旧调用方式（无回调）保持可用。
    await expect(facade.analyzeConflicts(candidates)).resolves.toEqual(
      expect.objectContaining({ candidates }),
    );
  });
});
