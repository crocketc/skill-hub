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

  // 计划 9.3：每次向导提交会话先开批次、后终结批次；测试按需排队这两
  // 个批次事实，中间留给逐项 prepare/commit 响应。
  function mockBeginBatch(batchId = "batch-1") {
    vi.mocked(executeCommand).mockResolvedValueOnce({
      type: "import_batch_started",
      payload: { batch_id: batchId },
    });
  }

  function mockFinalizeBatch(batchId = "batch-1", manageableSourceCount = "1") {
    vi.mocked(executeCommand).mockResolvedValueOnce({
      type: "import_batch_finalized",
      payload: { batch_id: batchId, manageable_source_count: manageableSourceCount },
    });
  }

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
        matches: [{
          skill_id: "skill-1",
          display_name: "Existing Notes",
          runtime_name: "notes",
          source: { kind: "local", locator: { local_path: "C:/library/notes" } },
          ownership: "central_library",
          basis: "runtime_name",
          duplicate_kind: "same_runtime_name_different_content",
          matched_fields: [],
        }],
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
        candidateName: "notes",
        kind: "same_name",
        required: true,
        matchedSkills: [{
          id: "skill-1",
          displayName: "Existing Notes",
          runtimeName: "notes",
          source: "C:/library/notes",
        }],
      }),
    ]);
  });

  it("reports live per-candidate progress as native analyses resolve", async () => {
    const progress = vi.fn();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "import_analysis",
      payload: {
        actions: ["skip"],
        candidate: {} as never,
        conflicts: [],
        duplicate_kind: null,
        matches: [],
      },
    });
    const makeCandidate = async (name: string) => ({
      basicCheck: "not_checked" as const,
      id: `C:/incoming/${name}#${name}`,
      name,
      ownership: "unknown" as const,
      path: `C:/incoming/${name}`,
      source: await nativeImportFacade.parseSource("C:/incoming"),
    });
    const first = await makeCandidate("alpha");
    const second = await makeCandidate("beta");

    await nativeImportFacade.analyzeConflicts([first, second], progress);

    // 候选数组长度即真实总数；每个候选查询 resolve 即真实已完成数。
    expect(progress).toHaveBeenNthCalledWith(1, { candidateId: first.id, completed: 1, total: 2 });
    expect(progress).toHaveBeenNthCalledWith(2, { candidateId: second.id, completed: 2, total: 2 });
  });

  it("prepares and commits a selected local candidate", async () => {
    const progress = vi.fn();
    mockBeginBatch();
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-1",
          candidate: {} as never,
          analysis: { actions: ["copy_into_library", "skip"] } as never,
        },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: {
          committed: true,
          batch: { batch_id: "batch-1" },
          items: [{ decision: "copy_into_library", governance_tasks: [], original_preserved: true, provenance: null, reason_code: null, skill_id: "skill-1", source_relation_id: "rel-1", status: "succeeded" }],
          operation_id: "operation-1",
        },
      });
    mockFinalizeBatch();

    const source = await nativeImportFacade.parseSource("C:/incoming");
    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source,
    };
    const outcome = await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      { [candidate.id]: "copy" },
      progress,
    );

    expect(executeCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "begin_import_batch" }));
    expect(executeCommand).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "prepare_import" }));
    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: "commit_import",
      payload: {
        decision: "copy_into_library",
        governance_decision: { group_actions: {}, item_overrides: {} },
        prepared_import_id: "operation-1",
        batch_id: "batch-1",
        candidate_key: candidate.id,
      },
    });
    expect(executeCommand).toHaveBeenLastCalledWith({
      type: "finalize_import_batch",
      payload: { batch_id: "batch-1" },
    });
    expect(outcome.batch).toEqual({ batchId: "batch-1", manageableSourceCount: 1 });
    expect(outcome.results).toEqual([{
      action: "copy",
      candidateId: candidate.id,
      governanceTasks: [],
      message: "importWorkflow.commitMessages.imported",
      originalPreserved: true,
      provenance: undefined,
      reasonCode: undefined,
      status: "succeeded",
      skillId: "skill-1",
      sourceRelationId: "rel-1",
    }]);
    expect(progress).toHaveBeenLastCalledWith({ candidateId: candidate.id, completed: 1, total: 1 });
  });

  it("uses an allowed default decision when a candidate has no required conflict", async () => {
    mockBeginBatch();
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-default",
          candidate: {} as never,
          analysis: { actions: ["copy_as_independent_managed_skill", "skip"] } as never,
        },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: {
          committed: true,
          batch: { batch_id: "batch-1" },
          items: [{ decision: "copy_as_independent_managed_skill", governance_tasks: [], original_preserved: true, provenance: null, reason_code: null, skill_id: "skill-default", status: "succeeded" }],
          operation_id: "operation-default",
        },
      });
    mockFinalizeBatch();
    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/builtin#builtin",
      name: "builtin",
      ownership: "plugin" as const,
      path: "C:/incoming/builtin",
      source: await nativeImportFacade.parseSource("C:/incoming"),
    };

    const { results: [result] } = await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      {},
    );

    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: "commit_import",
      payload: {
        decision: "copy_as_independent_managed_skill",
        governance_decision: { group_actions: {}, item_overrides: {} },
        prepared_import_id: "operation-default",
        batch_id: "batch-1",
        candidate_key: candidate.id,
      },
    });
    expect(result).toEqual(expect.objectContaining({ action: "independent", status: "succeeded" }));
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
    mockBeginBatch();
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-2",
          candidate: nativeCandidate,
          analysis: { actions: ["copy_into_library", "skip"] } as never,
        },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: { committed: true, batch: { batch_id: "batch-1" }, items: [{ decision: "copy_into_library", governance_tasks: [], original_preserved: true, provenance: null, reason_code: null, skill_id: "skill-2", status: "succeeded" }], operation_id: "operation-2" },
      });
    mockFinalizeBatch();

    const source = await nativeImportFacade.parseSource("C:/workspace");
    const [candidate] = await nativeImportFacade.acquireCandidates(source);
    const plan = await nativeImportFacade.analyzeConflicts([candidate]);
    await nativeImportFacade.commitImport(plan, { [candidate.id]: "copy" });

    expect(queryApplication).toHaveBeenLastCalledWith({
      type: "analyze_import",
      payload: { candidate: nativeCandidate, tree_hash: null },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: "prepare_import",
      payload: { candidate: nativeCandidate, tree_hash: null },
    });
  });

  it("resolves unknown native error codes to readable copy for failed imports", async () => {
    mockBeginBatch();
    vi.mocked(executeCommand).mockRejectedValueOnce({
      code: "io_error",
      params: { operation: "capture", path: "C:/incoming/notes" },
    });
    mockFinalizeBatch("batch-1", "0");

    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source: await nativeImportFacade.parseSource("C:/incoming"),
    };
    const { batch, results: [result] } = await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      { [candidate.id]: "copy" },
    );

    // 未知码不允许裸码上屏：统一兜底为可读文案；码本身留档操作记录。
    expect(result).toEqual(expect.objectContaining({
        message: "importWorkflow.errors.unknown",
        reasonCode: "io_error",
        originalPreserved: true,
        governanceTasks: [],
        status: "failed",
    }));
    // 失败项不产生来源关系：批次计数如实为 0（计划 9.3 online-only=0 语义）。
    expect(batch).toEqual({ batchId: "batch-1", manageableSourceCount: 0 });
  });

  it("maps known native error codes to their translation keys", async () => {
    mockBeginBatch();
    vi.mocked(executeCommand).mockRejectedValueOnce({
      code: "network.disabled",
    });
    mockFinalizeBatch("batch-1", "0");

    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source: await nativeImportFacade.parseSource("C:/incoming"),
    };
    const { results: [result] } = await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      { [candidate.id]: "copy" },
    );

    expect(result).toEqual(expect.objectContaining({
      message: "errors.networkDisabled",
      status: "failed",
    }));
  });

  it("maps takeover verification conflicts by their structured reason", async () => {
    mockBeginBatch();
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-takeover-mismatch",
          candidate: {} as never,
          analysis: { actions: ["take_over_after_verify", "skip"] } as never,
        },
      })
      .mockRejectedValueOnce({
        code: "operation.conflict",
        params: { reason: "takeover_verification_mismatch" },
      });
    mockFinalizeBatch("batch-1", "0");

    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "agent_builtin" as const,
      path: "C:/incoming/notes",
      source: await nativeImportFacade.parseSource("C:/incoming"),
    };
    const { results: [result] } = await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      { [candidate.id]: "takeover" },
    );

    expect(result).toEqual(expect.objectContaining({
      message: "importWorkflow.errors.takeoverVerificationMismatch",
      reasonCode: "operation.conflict",
      status: "failed",
    }));
  });

  it("normalizes Windows extended prefixes for display and native requests", async () => {
    const extendedRoot = "\\\\?\\C:\\Users\\demo\\.agents\\skills";
    vi.mocked(queryApplication).mockResolvedValue({
      type: "import_candidates",
      payload: [{
        absolute_root: `${extendedRoot}\\pptx`,
        default_action: "review",
        marker: "SKILL.md",
        ownership: "arbitrary_local_directory",
        ownership_detail: null,
        relative_root: "pptx",
        runtime_name: "pptx",
        source: { kind: "local", locator: { local_path: extendedRoot } },
      }],
    });

    const candidates = await nativeImportFacade.acquireCandidates(await nativeImportFacade.parseSource(extendedRoot));

    expect(candidates[0]).toEqual(expect.objectContaining({
      id: "C:\\Users\\demo\\.agents\\skills\\pptx#pptx",
      path: "C:\\Users\\demo\\.agents\\skills\\pptx",
      source: expect.objectContaining({
        displayTarget: "C:\\Users\\demo\\.agents\\skills",
        input: "C:\\Users\\demo\\.agents\\skills",
      }),
    }));
    expect(queryApplication).toHaveBeenCalledWith({
      type: "discover_import_candidates",
      payload: { source: { kind: "local", locator: { local_path: "C:\\Users\\demo\\.agents\\skills" } } },
    });
  });

  it("passes recognized remote Git sources to the native acquisition boundary", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "import_candidates",
      payload: [{
        absolute_root: "C:/Temp/skillhub-acquired/pdf",
        default_action: "review",
        marker: "SKILL.md",
        ownership: "downloaded_source",
        ownership_detail: null,
        relative_root: "pdf",
        runtime_name: "pdf",
        source: { kind: "git", locator: { git_url: "https://github.com/example/skills" } },
      }],
    });
    const source = await nativeImportFacade.parseSource("https://github.com/example/skills");
    const [candidate] = await nativeImportFacade.acquireCandidates(source);

    expect(queryApplication).toHaveBeenCalledWith({
      type: "discover_import_candidates",
      payload: { source: { kind: "git", locator: { git_url: "https://github.com/example/skills" } } },
    });
    expect(candidate.source).toEqual(expect.objectContaining({
      kind: "git",
      displayTarget: "https://github.com/example/skills",
    }));
  });

  it("maps the independent action to the decision allowed by native conflict analysis", async () => {
    const candidate = {
      basicCheck: "not_checked" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source: await nativeImportFacade.parseSource("C:/incoming"),
    };
    vi.mocked(queryApplication).mockResolvedValue({
      type: "import_analysis",
      payload: {
        actions: ["keep_independent", "skip"],
        candidate: {} as never,
        conflicts: [],
        duplicate_kind: "same_runtime_name_different_content",
        matches: [],
      },
    });
    await nativeImportFacade.analyzeConflicts([candidate]);
    mockBeginBatch();
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-3",
          candidate: {} as never,
          analysis: { actions: ["copy_as_independent_managed_skill", "skip"] } as never,
        },
      })
      .mockResolvedValueOnce({ type: "import_summary", payload: { committed: true, batch: { batch_id: "batch-1" }, items: [{ decision: "copy_as_independent_managed_skill", governance_tasks: [], original_preserved: true, provenance: null, reason_code: null, skill_id: "skill-3", status: "succeeded" }], operation_id: "operation-3" } });
    mockFinalizeBatch("batch-1", "0");

    await nativeImportFacade.commitImport({ candidates: [candidate], conflicts: [] }, { [candidate.id]: "independent" });

    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: "commit_import",
      payload: { decision: "copy_as_independent_managed_skill", governance_decision: { group_actions: {}, item_overrides: {} }, prepared_import_id: "operation-3", batch_id: "batch-1", candidate_key: candidate.id },
    });
  });

  // 计划 9.3：一次向导提交会话只创建一个批次；逐项 commit 复用同一
  // batch_id；批次级上下文由 finalize 返回，失败/无来源关系的会话
  // 如实为 0。
  it("creates exactly one batch per commit session and reuses it for every item", async () => {
    mockBeginBatch("batch-session");
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-a",
          candidate: {} as never,
          analysis: { actions: ["copy_into_library", "skip"] } as never,
        },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: {
          committed: true,
          batch: { batch_id: "batch-session" },
          items: [{ decision: "copy_into_library", governance_tasks: [], original_preserved: true, provenance: null, reason_code: null, skill_id: "skill-a", source_relation_id: "rel-a", status: "succeeded" }],
          operation_id: "operation-a",
        },
      })
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-b",
          candidate: {} as never,
          analysis: { actions: ["copy_into_library", "skip"] } as never,
        },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: {
          committed: true,
          batch: { batch_id: "batch-session" },
          items: [{ decision: "reuse_existing", governance_tasks: [], original_preserved: true, provenance: null, reason_code: null, skill_id: "skill-b", source_relation_id: null, status: "succeeded" }],
          operation_id: "operation-b",
        },
      });
    mockFinalizeBatch("batch-session", "1");

    const source = await nativeImportFacade.parseSource("C:/incoming");
    const first = {
      basicCheck: "passed" as const,
      id: "C:/incoming/one#one",
      name: "one",
      ownership: "unknown" as const,
      path: "C:/incoming/one",
      source,
    };
    const second = {
      basicCheck: "passed" as const,
      id: "C:/incoming/two#two",
      name: "two",
      ownership: "unknown" as const,
      path: "C:/incoming/two",
      source,
    };
    const outcome = await nativeImportFacade.commitImport(
      { candidates: [first, second], conflicts: [] },
      { [first.id]: "copy", [second.id]: "copy" },
    );

    const batchCommands = vi.mocked(executeCommand).mock.calls.filter(
      ([command]) => command.type === "begin_import_batch",
    );
    expect(batchCommands).toHaveLength(1);
    expect(executeCommand).toHaveBeenNthCalledWith(1, { type: "begin_import_batch", payload: {} });
    expect(executeCommand).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: "commit_import",
      payload: expect.objectContaining({ batch_id: "batch-session", candidate_key: first.id }),
    }));
    expect(executeCommand).toHaveBeenNthCalledWith(5, expect.objectContaining({
      type: "commit_import",
      payload: expect.objectContaining({ batch_id: "batch-session", candidate_key: second.id }),
    }));
    expect(executeCommand).toHaveBeenLastCalledWith({
      type: "finalize_import_batch",
      payload: { batch_id: "batch-session" },
    });
    expect(outcome.batch).toEqual({ batchId: "batch-session", manageableSourceCount: 1 });
    expect(outcome.results.map((result) => result.skillId)).toEqual(["skill-a", "skill-b"]);
    expect(outcome.results.map((result) => result.sourceRelationId)).toEqual(["rel-a", undefined]);
  });
});
