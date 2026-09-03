import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeImportFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

describe("native import facade", () => {
  beforeEach(async () => {
    vi.mocked(queryApplication).mockReset();
    vi.mocked(executeCommand).mockReset();
    await nativeImportFacade.cancel();
  });

  it("discovers local candidates through the typed native query", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "import_candidates",
      payload: [
        {
          absolute_root: "C:/incoming/notes",
          default_action: "review",
          marker: "SKILL.md",
          ownership: "arbitrary_local_directory",
          ownership_detail: null,
          relative_root: "notes",
          runtime_name: "notes",
          source: { kind: "local", locator: { local_path: "C:/incoming" } },
        },
      ],
    });

    const source = await nativeImportFacade.parseSource("C:/incoming");
    const candidates = await nativeImportFacade.acquireCandidates(source);

    expect(queryApplication).toHaveBeenCalledWith({
      type: "discover_import_candidates",
      payload: { source: { kind: "local", locator: { local_path: "C:/incoming" } } },
    });
    expect(candidates).toEqual([
      expect.objectContaining({
        basicCheck: "not_checked",
        id: "C:/incoming/notes#notes",
        name: "notes",
        ownership: "unknown",
        path: "C:/incoming/notes",
      }),
    ]);
  });

  it("combines deterministic native analyses into a conflict plan", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "import_analysis",
      payload: {
        actions: ["keep_independent", "skip"],
        candidate: {
          absolute_root: "C:/incoming/notes",
          default_action: "review",
          marker: "SKILL.md",
          ownership: "arbitrary_local_directory",
          ownership_detail: null,
          relative_root: "notes",
          runtime_name: "notes",
          source: { kind: "local", locator: { local_path: "C:/incoming" } },
        },
        conflicts: [{
          kind: "same_runtime_name_different_content",
          reason_code: "import.same_runtime_name_conflict",
          requires_choice: true,
          skill_id: "skill-1",
        }],
        duplicate_kind: "same_runtime_name_different_content",
        matches: [],
      },
    });

    const candidate = {
      basicCheck: "not_checked" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source: await nativeImportFacade.parseSource("C:/incoming"),
    };
    const plan = await nativeImportFacade.analyzeConflicts([candidate]);

    expect(queryApplication).toHaveBeenCalledWith(expect.objectContaining({ type: "analyze_import" }));
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        allowedActions: ["independent", "skip"],
        candidateId: candidate.id,
        kind: "same_name",
        required: true,
      }),
    ]);
  });

  it("prepares and commits a selected local candidate", async () => {
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: { id: "operation-1", candidate: {} as never, analysis: {} as never },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: { committed: true, items: [{ decision: "copy_into_library", original_preserved: true, skill_id: "skill-1" }], operation_id: "operation-1" },
      });

    const source = await nativeImportFacade.parseSource("C:/incoming");
    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source,
    };
    const results = await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      { [candidate.id]: "copy" },
    );

    expect(executeCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "prepare_import" }));
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: "commit_import",
      payload: { decision: "copy_into_library", prepared_import_id: "operation-1" },
    });
    expect(results).toEqual([{ action: "copy", candidateId: candidate.id, message: "已导入", status: "succeeded" }]);
  });

  it("reuses the discovered native candidate for analysis and preparation", async () => {
    const nativeCandidate = {
      absolute_root: "C:/workspace/skills/notes",
      default_action: "establish_managed_relation" as const,
      marker: "SKILL.md",
      ownership: "registered_project" as const,
      ownership_detail: "project-aurora",
      relative_root: "skills/notes",
      runtime_name: "notes",
      source: { kind: "local" as const, locator: { local_path: "C:/workspace" } },
    };
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({ type: "import_candidates", payload: [nativeCandidate] })
      .mockResolvedValueOnce({
        type: "import_analysis",
        payload: {
          actions: ["establish_managed_relation"],
          candidate: nativeCandidate,
          conflicts: [],
          duplicate_kind: null,
          matches: [],
        },
      });
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: { id: "operation-2", candidate: nativeCandidate, analysis: {} as never },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: { committed: true, items: [{ decision: "copy_into_library", original_preserved: true, skill_id: "skill-2" }], operation_id: "operation-2" },
      });

    const source = await nativeImportFacade.parseSource("C:/workspace");
    const [candidate] = await nativeImportFacade.acquireCandidates(source);
    const plan = await nativeImportFacade.analyzeConflicts([candidate]);
    await nativeImportFacade.commitImport(plan, { [candidate.id]: "copy" });

    expect(queryApplication).toHaveBeenLastCalledWith({
      type: "analyze_import",
      payload: { candidate: nativeCandidate, tree_hash: null },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(1, {
      type: "prepare_import",
      payload: { candidate: nativeCandidate, tree_hash: null },
    });
  });
});
