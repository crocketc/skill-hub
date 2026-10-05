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
    expect(results.results.map((result) => result.status)).toEqual([
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

  // W2-2（FB-007）：批内分组场景——同内容建议合并、同名成员未处置即拒绝。
  it("fixtures the batch-conflicts scenario with merge suggestions and disposition gates", async () => {
    const facade = createMockImportFacade({ scenario: "batch-conflicts" });
    const source = await facade.parseSource("C:\\Incoming");
    const candidates = await facade.acquireCandidates(source);
    const plan = await facade.analyzeConflicts(candidates);

    expect(plan.batchAnalysis).toEqual({
      sameContentGroups: [
        expect.objectContaining({
          keepCandidateId: candidates[0].id,
          normalizedRuntimeName: "notes sync",
          skipCandidateIds: [candidates[1].id],
        }),
      ],
      sameNameGroups: [
        expect.objectContaining({
          candidateIds: [candidates[2].id, candidates[3].id],
          normalizedRuntimeName: "alpha",
        }),
      ],
      signature: expect.any(String),
    });

    // 同名成员未显式处置（copy 不算处置）→ 提交被拒并映射为引导文案。
    const blocked = await facade.commitImport(plan, {
      [candidates[0].id]: "copy",
      [candidates[1].id]: "skip",
      [candidates[2].id]: "copy",
      [candidates[3].id]: "copy",
    });
    expect(blocked.results.map((result) => result.status)).toEqual([
      "succeeded",
      "skipped",
      "failed",
      "failed",
    ]);
    for (const result of blocked.results.slice(2)) {
      expect(result).toEqual(expect.objectContaining({
        message: "importWorkflow.errors.sameNameDispositionRequired",
        reasonCode: "import.same_name_disposition_required",
      }));
    }

    // 逐项处置（独立命名 + 跳过）后成功；出参如实记录处置与签名。
    const signature = plan.batchAnalysis!.signature;
    const settled = await facade.commitImport(
      plan,
      {
        [candidates[0].id]: "copy",
        [candidates[1].id]: "skip",
        [candidates[2].id]: "independent",
        [candidates[3].id]: "skip",
      },
      undefined,
      undefined,
      {
        runtimeNameOverrides: { [candidates[2].id]: "Alpha Prime" },
        batchSignature: signature,
      },
    );
    expect(settled.results.map((result) => result.status)).toEqual([
      "succeeded",
      "skipped",
      "succeeded",
      "skipped",
    ]);
    expect(facade.calls.committedDispositions).toEqual([
      { batchSignature: signature, runtimeNameOverrides: { [candidates[2].id]: "Alpha Prime" } },
    ]);
  });

  it("rejects a stale batch signature with the composition-changed guidance", async () => {
    const facade = createMockImportFacade({ scenario: "batch-conflicts" });
    const source = await facade.parseSource("C:\\Incoming");
    const candidates = await facade.acquireCandidates(source);
    const plan = await facade.analyzeConflicts(candidates);

    const stale = await facade.commitImport(
      plan,
      {
        [candidates[0].id]: "copy",
        [candidates[1].id]: "skip",
        [candidates[2].id]: "independent",
        [candidates[3].id]: "skip",
      },
      undefined,
      undefined,
      {
        runtimeNameOverrides: { [candidates[2].id]: "Alpha Prime" },
        batchSignature: "mock-stale-signature",
      },
    );

    for (const result of stale.results) {
      expect(result).toEqual(expect.objectContaining({
        message: "importWorkflow.errors.batchCompositionChanged",
        reasonCode: "import.batch_composition_changed",
        status: "failed",
      }));
    }
  });
});
