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

  // W2-2：提交期以真实批次号重跑批内分析；返回最新组成签名。
  function mockCommitBatchAnalysis(signature = "commit-batch-sig") {
    vi.mocked(queryApplication).mockResolvedValueOnce({
      type: "import_batch_analysis",
      payload: { same_content_groups: [], same_name_groups: [], signature },
    });
    return signature;
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
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        type: "import_batch_analysis",
        payload: {
          same_content_groups: [{
            candidate_tree_hash: "hash-a",
            keep_candidate_key: "native-a|notes",
            normalized_runtime_name: "notes",
            skip_candidate_keys: ["native-b|notes"],
          }],
          same_name_groups: [],
          signature: "analysis-batch-sig",
        },
      });

    const candidate = {
      basicCheck: "not_checked" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      relativeRoot: "notes",
      source: await nativeImportFacade.parseSource("C:/incoming"),
    };
    const plan = await nativeImportFacade.analyzeConflicts([candidate]);

    // 批内互检与库内分析并行发出；展示阶段尚无批次号，batch_id 为 null。
    expect(queryApplication).toHaveBeenCalledWith({
      type: "analyze_import_batch",
      payload: {
        batch_id: null,
        candidates: [expect.objectContaining({ runtime_name: "notes" })],
      },
    });
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
    // 组成员键由后端稳定键映射回前端候选（相对根后缀）；无法映射的键
    // 如实丢弃，不伪造成员。
    expect(plan.batchAnalysis).toEqual({
      sameContentGroups: [{
        keepCandidateId: candidate.id,
        normalizedRuntimeName: "notes",
        skipCandidateIds: [],
      }],
      sameNameGroups: [],
      signature: "analysis-batch-sig",
    });
  });

  it("reports live per-candidate progress as native analyses resolve", async () => {
    const progress = vi.fn();
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "import_analysis",
        payload: {
          actions: ["skip"],
          candidate: {} as never,
          conflicts: [],
          duplicate_kind: null,
          matches: [],
        },
      })
      .mockResolvedValueOnce({
        type: "import_analysis",
        payload: {
          actions: ["skip"],
          candidate: {} as never,
          conflicts: [],
          duplicate_kind: null,
          matches: [],
        },
      })
      .mockResolvedValueOnce({
        type: "import_batch_analysis",
        payload: { same_content_groups: [], same_name_groups: [], signature: "sig" },
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
    mockCommitBatchAnalysis("commit-batch-sig");
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
    // W2-2：candidate_key 缺省——稳定键由应用层从来源与相对根派生（与批内
    // 分析同一形态）；前端展示键不冒充身份。commit 携带提交期最新签名。
    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: "commit_import",
      payload: {
        decision: "copy_into_library",
        governance_decision: { group_actions: {}, item_overrides: {} },
        prepared_import_id: "operation-1",
        batch_id: "batch-1",
        batch_signature: "commit-batch-sig",
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
    mockCommitBatchAnalysis();
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
        batch_signature: "commit-batch-sig",
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
      })
      .mockResolvedValueOnce({
        type: "import_batch_analysis",
        payload: { same_content_groups: [], same_name_groups: [], signature: "analysis-sig" },
      });
    mockBeginBatch();
    mockCommitBatchAnalysis("commit-sig");
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

    expect(queryApplication).toHaveBeenNthCalledWith(2, {
      type: "analyze_import",
      payload: { candidate: nativeCandidate, tree_hash: null },
    });
    // 展示阶段批内分析不暂存（batch_id=null），提交阶段以真实批次号重跑。
    expect(queryApplication).toHaveBeenNthCalledWith(3, {
      type: "analyze_import_batch",
      payload: { batch_id: null, candidates: [nativeCandidate] },
    });
    expect(queryApplication).toHaveBeenLastCalledWith({
      type: "analyze_import_batch",
      payload: { batch_id: "batch-1", candidates: [nativeCandidate] },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: "prepare_import",
      payload: { candidate: nativeCandidate, tree_hash: null },
    });
  });

  it("resolves unknown native error codes to readable copy for failed imports", async () => {
    mockBeginBatch();
    mockCommitBatchAnalysis();
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
    mockCommitBatchAnalysis();
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
    mockCommitBatchAnalysis();
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
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "import_analysis",
        payload: {
          actions: ["keep_independent", "skip"],
          candidate: {} as never,
          conflicts: [],
          duplicate_kind: "same_runtime_name_different_content",
          matches: [],
        },
      })
      .mockResolvedValueOnce({
        type: "import_batch_analysis",
        payload: {
          same_content_groups: [],
          same_name_groups: [{
            candidate_keys: ["native-a|notes"],
            normalized_runtime_name: "notes",
          }],
          signature: "analysis-sig",
        },
      });
    await nativeImportFacade.analyzeConflicts([candidate]);
    mockBeginBatch();
    mockCommitBatchAnalysis("commit-sig");
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
      payload: { decision: "copy_as_independent_managed_skill", governance_decision: { group_actions: {}, item_overrides: {} }, prepared_import_id: "operation-3", batch_id: "batch-1", batch_signature: "commit-sig" },
    });
  });

  // 计划 9.3：一次向导提交会话只创建一个批次；逐项 commit 复用同一
  // batch_id；批次级上下文由 finalize 返回，失败/无来源关系的会话
  // 如实为 0。
  it("creates exactly one batch per commit session and reuses it for every item", async () => {
    mockBeginBatch("batch-session");
    mockCommitBatchAnalysis("session-sig");
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
    // 提交期批内分析恰好重跑一次（同一 batch_id），两个候选项共用同一签名。
    const batchQueries = vi.mocked(queryApplication).mock.calls.filter(
      ([query]) => query.type === "analyze_import_batch",
    );
    expect(batchQueries).toHaveLength(1);
    expect(batchQueries[0]).toEqual([{
      type: "analyze_import_batch",
      payload: {
        batch_id: "batch-session",
        candidates: [expect.objectContaining({ runtime_name: "one" }), expect.objectContaining({ runtime_name: "two" })],
      },
    }]);
    expect(executeCommand).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: "commit_import",
      payload: expect.objectContaining({ batch_id: "batch-session", batch_signature: "session-sig" }),
    }));
    expect(executeCommand).toHaveBeenNthCalledWith(5, expect.objectContaining({
      type: "commit_import",
      payload: expect.objectContaining({ batch_id: "batch-session", batch_signature: "session-sig" }),
    }));
    expect(executeCommand).toHaveBeenLastCalledWith({
      type: "finalize_import_batch",
      payload: { batch_id: "batch-session" },
    });
    expect(outcome.batch).toEqual({ batchId: "batch-session", manageableSourceCount: 1 });
    expect(outcome.results.map((result) => result.skillId)).toEqual(["skill-a", "skill-b"]);
    expect(outcome.results.map((result) => result.sourceRelationId)).toEqual(["rel-a", undefined]);
  });

  // W2-2（FB-007）：独立命名与批内签名贯穿 prepare/commit 出参。
  it("carries the independent rename and the fresh batch signature through prepare and commit", async () => {
    mockBeginBatch("batch-rename");
    mockCommitBatchAnalysis("fresh-sig");
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-rename",
          candidate: {} as never,
          analysis: { actions: ["copy_as_independent_managed_skill", "skip"] } as never,
        },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: {
          committed: true,
          batch: { batch_id: "batch-rename" },
          items: [{ decision: "copy_as_independent_managed_skill", governance_tasks: [], original_preserved: true, provenance: null, reason_code: null, skill_id: "skill-renamed", status: "succeeded" }],
          operation_id: "operation-rename",
        },
      });
    mockFinalizeBatch("batch-rename", "1");

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
      { [candidate.id]: "independent" },
      undefined,
      undefined,
      { runtimeNameOverrides: { [candidate.id]: "Notes Renamed" }, batchSignature: "plan-sig" },
    );

    // 提交期以真实批次号重跑批内分析（存储分析 + 取最新签名）。
    expect(queryApplication).toHaveBeenLastCalledWith({
      type: "analyze_import_batch",
      payload: {
        batch_id: "batch-rename",
        candidates: [expect.objectContaining({ runtime_name: "notes" })],
      },
    });
    // prepare 与 commit 携带同一覆盖名（后端要求两次一致）。
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: "prepare_import",
      payload: {
        candidate: expect.anything(),
        tree_hash: null,
        runtime_name_override: "Notes Renamed",
      },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: "commit_import",
      payload: {
        decision: "copy_as_independent_managed_skill",
        governance_decision: { group_actions: {}, item_overrides: {} },
        prepared_import_id: "operation-rename",
        batch_id: "batch-rename",
        batch_signature: "fresh-sig",
        runtime_name_override: "Notes Renamed",
      },
    });
    expect(outcome.results[0]).toEqual(expect.objectContaining({ status: "succeeded" }));
  });

  it("does not attach a runtime override to a skipped candidate", async () => {
    mockBeginBatch();
    mockCommitBatchAnalysis();
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "prepared_import",
        payload: {
          id: "operation-skip",
          candidate: {} as never,
          analysis: { actions: ["skip"] } as never,
        },
      })
      .mockResolvedValueOnce({
        type: "import_summary",
        payload: {
          committed: false,
          batch: { batch_id: "batch-1" },
          items: [{ decision: "skip", governance_tasks: [], original_preserved: true, provenance: null, reason_code: "import.skipped_by_user", skill_id: null, status: "skipped" }],
          operation_id: "operation-skip",
        },
      });
    mockFinalizeBatch("batch-1", "0");

    const source = await nativeImportFacade.parseSource("C:/incoming");
    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source,
    };
    await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      { [candidate.id]: "skip" },
      undefined,
      undefined,
      { runtimeNameOverrides: { [candidate.id]: "Notes Renamed" }, batchSignature: null },
    );

    // skip + 覆盖名是非法组合（后端拒绝）：出参绝不携带覆盖名。
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: "prepare_import",
      payload: { candidate: expect.anything(), tree_hash: null },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: "commit_import",
      payload: expect.not.objectContaining({ runtime_name_override: expect.anything() }),
    }));
  });

  // W2-2：三个新错误码映射为可读引导文案，不裸码上屏。
  it.each([
    ["import.runtime_name_conflict", "importWorkflow.errors.runtimeNameConflict"],
    ["import.same_name_disposition_required", "importWorkflow.errors.sameNameDispositionRequired"],
    ["import.batch_composition_changed", "importWorkflow.errors.batchCompositionChanged"],
  ])("maps %s to its guidance key", async (code, expectedKey) => {
    mockBeginBatch();
    mockCommitBatchAnalysis();
    vi.mocked(executeCommand).mockRejectedValueOnce({ code });
    mockFinalizeBatch("batch-1", "0");

    const source = await nativeImportFacade.parseSource("C:/incoming");
    const candidate = {
      basicCheck: "passed" as const,
      id: "C:/incoming/notes#notes",
      name: "notes",
      ownership: "unknown" as const,
      path: "C:/incoming/notes",
      source,
    };
    const { results: [result] } = await nativeImportFacade.commitImport(
      { candidates: [candidate], conflicts: [] },
      { [candidate.id]: "copy" },
    );

    expect(result).toEqual(expect.objectContaining({
      message: expectedKey,
      reasonCode: code,
      status: "failed",
    }));
  });
});
