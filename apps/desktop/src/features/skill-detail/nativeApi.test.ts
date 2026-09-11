import { describe, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import {
  nativeSkillDetailFacade,
  setNativeCurrentVersion,
  setNativeFindingDisposition,
} from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

describe("native skill detail facade", () => {
  it("maps the native skill projection to summary and metadata", async () => {
    const skillPayload = {
      type: "skill" as const,
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        runtime_name: "pdf-reader",
        original_description: "Extract tables",
        translated_description: "提取表格",
        user_note: "Review before deployment",
        user_purpose: "用于 PDF 表格提取",
        tags: ["documents", "pdf"],

        author: null,
        license: "MIT",
        lifecycle: "Normal" as const,
        trial_due: "2026-09-15",
        current_version: null,
      },
    };
    const translationsPayload = {
      type: "translations" as const,
      payload: [
        {
          record: {
            skill_id: "skill-1",
            language: "zh-CN",
            text: "提取表格的译文",
            provenance: {
              source_description_hash: "fnv1a:0abc",
              provider: "test",
              model: "test-model",
              origin: "generated" as const,
            },
            origin: "generated" as const,
          },
          version_id: "version-1",
          created_at: "1",
          updated_at: "2",
          needs_update: true,
        },
      ],
    };
    // getSummary 与 getMetadata 各读一次 skill；getMetadata 额外读取持久化译文。
    vi.mocked(queryApplication)
      .mockResolvedValueOnce(skillPayload)
      .mockResolvedValueOnce(skillPayload)
      .mockResolvedValueOnce(translationsPayload);

    // P1-12：概览用途唯一口径——用户用途优先（QA-008），缺省回退译文、再回退原文。
    // 头部不再重复展示用途，概览是全页唯一的用途陈述。
    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      id: "skill-1",
      name: "PDF Reader",
      purpose: "用于 PDF 表格提取",
      lifecycle: "trial",
      trialDue: "2026-09-15",
    });
    // QA-008：元数据面板的用途来自用户独立字段，不得用译文冒充；显示别名即 display_name。
    await expect(nativeSkillDetailFacade.getMetadata("skill-1")).resolves.toEqual({
      alias: "PDF Reader",
      originalDescription: "Extract tables",
      purpose: "用于 PDF 表格提取",
      note: "Review before deployment",
      tags: ["documents", "pdf"],
      license: "MIT",
      translation: {
        locale: "zh-CN",
        model: "test-model",
        sourceVersion: "version-1",
        stale: true,
        text: "提取表格的译文",
        translatedAt: "2",
        userRevised: false,
      },
    });
    expect(queryApplication).toHaveBeenCalledWith({
      type: "list_translations",
      payload: { skill_id: "skill-1" },
    });
  });

  it("falls back to the translated description for the overview purpose when no user purpose exists", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "skill",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        runtime_name: "pdf-reader",
        original_description: "Extract tables",
        translated_description: "提取表格",
        user_note: null,
        user_purpose: null,
        tags: [],
        author: null,
        license: null,
        lifecycle: "Normal" as const,
        trial_due: null,
        current_version: null,
      },
    });

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      purpose: "提取表格",
    });
  });

  it("saves metadata patches through the full overwrite contract without dropping fields", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "skill",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        runtime_name: "pdf-reader",
        original_description: "Extract tables",
        translated_description: "提取表格",
        user_note: "Review before deployment",
        user_purpose: "用于 PDF 表格提取",
        tags: ["documents"],
        author: "Ada",
        license: "MIT",
        lifecycle: "Normal" as const,
        trial_due: null,
        current_version: null,
      },
    });
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-1", phase: "committed", message_code: "ok", error_code: null },
    });

    await nativeSkillDetailFacade.saveMetadata("skill-1", {
      purpose: "新的本地用途",
      tags: ["new-tag"],
    });

    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_skill",
      payload: { skill_id: "skill-1" },
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_metadata",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        note: "Review before deployment",
        tags: ["new-tag"],
        author: "Ada",
        license: "MIT",
        user_purpose: "新的本地用途",
      },
    });
  });

  it("clears an alias back to the runtime name through the metadata contract", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "skill",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        runtime_name: "pdf-reader",
        original_description: "Extract tables",
        translated_description: null,
        user_note: null,
        user_purpose: null,
        tags: [],
        author: null,
        license: null,
        lifecycle: "Normal" as const,
        trial_due: null,
        current_version: null,
      },
    });
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-2", phase: "committed", message_code: "ok", error_code: null },
    });

    await nativeSkillDetailFacade.saveMetadata("skill-1", { alias: null });

    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_metadata",
      payload: {
        skill_id: "skill-1",
        display_name: "pdf-reader",
        note: null,
        tags: [],
        author: null,
        license: null,
        user_purpose: null,
      },
    });
  });

  it("turns an unexpected native result into the standard unavailable error", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "bootstrap_snapshot",
      payload: {
        initialization_state: "initialized",
        library_path: "C:\\Users\\Test\\SkillHub",
        onboarding_skipped: false,
        skill_count: 0,
        project_count: 0,
        agent_count: 0,
        discovered_agent_count: 0,
        deployed_count: 0,
        deployment_categories: [],
        tag_categories: [],
        recent_operations: [],
        pending: { total: 0, by_kind: {} },
        last_scan_at: null,
        recovery_state: "clean",
      },
    });

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && error.name === "SkillDetailUnavailableError",
    );
  });

  it("maps independent native check states when a current version exists", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "skill",
        payload: {
          skill_id: "skill-1",
          display_name: "PDF Reader",
          runtime_name: "pdf-reader",
          original_description: "Extract tables",
          translated_description: null,
          user_note: null,
          user_purpose: null,
          tags: [],

          author: null,
          license: null,
          lifecycle: "Normal" as const,
          trial_due: null,
          // QA-010：后端推导的可读标签与原始版本身份（内容哈希）分离。
          current_version: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          current_version_label: "v3",
        },
      })
      .mockResolvedValueOnce({
        type: "basic_check_result",
        payload: {
          skill_id: "skill-1",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          state: "passed",
          run_id: "basic-run",
          ruleset_id: "rules-v1",
          checked_at: "2026-08-29T00:00:00Z",
          finding_count: 0,
          actionable_count: 0,
        },
      })
      .mockResolvedValueOnce({
        type: "llm_safety_check_result",
        payload: {
          skill_id: "skill-1",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          state: "failed",
          run_id: "llm-run",
          model_id: "model-v1",
          checked_at: "2026-08-29T00:00:00Z",
          finding_count: 1,
          actionable_count: 1,
        },
      });

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      basicCheck: "passed",
      aiCheck: "failed",
      // QA-010：概览展示可读标签，不暴露内容哈希。
      currentVersion: "v3",
    });
    expect(queryApplication).toHaveBeenCalledTimes(3);
  });

  it("maps structured findings for the selected check kind", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "findings",
      payload: [{
        id: "finding-1",
        code: "prompt_injection",
        severity: "critical",
        file: "SKILL.md",
        line_start: 4,
        line_end: 4,
        disposition: "actionable",
        high_risk: true,
      }],
    });

    await expect(nativeSkillDetailFacade.getFindings(
      "skill-1",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "basic",
    )).resolves.toEqual([{
      id: "finding-1",
      code: "prompt_injection",
      severity: "critical",
      file: "SKILL.md",
      disposition: "actionable",
      highRisk: true,
    }]);
  });

  it("maps native deployment relations with their registered target labels and paths", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "deployment_relations",
        payload: [{
          id: "deployment-1",
          skill_id: "skill-1",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          target_id: "codex-global",
          state: "deployed",
          mode: "managed_copy",
          managed: true,
          runtime_name: "pdf-reader",
          expected_hash: "sha256:tree",
          observed_hash: "sha256:tree",
        }],
      })
      .mockResolvedValueOnce({
        type: "deployment_targets",
        payload: [{
          id: "codex-global",
          label: "Codex CLI",
          path: "C:/Users/demo/.codex/skills",
          available: true,
          physical_id: "fs:codex",
          modes: ["managed_copy"],
        }],
      });

    await expect(nativeSkillDetailFacade.getRelations("skill-1")).resolves.toEqual([{
      affectedByCurrentVersion: true,
      id: "deployment-1",
      kind: "agent",
      label: "Codex CLI",
      logicalTarget: "codex-global",
      physicalTarget: "C:/Users/demo/.codex/skills/pdf-reader",
      pinned: false,
      version: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }]);
    expect(queryApplication).toHaveBeenNthCalledWith(1, {
      type: "get_deployment_relations",
      payload: { skill_id: "skill-1" },
    });
    expect(queryApplication).toHaveBeenNthCalledWith(2, {
      type: "list_deployment_targets",
      payload: null,
    });
  });

  it("maps the persisted journal into the operation history with an honest limitation", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "skill_operations",
        payload: {
          skill_id: "skill-1",
          entries: [
            { operation_id: "op-1", kind: "deploy_skill", phase: "committed", error_code: null },
            {
              operation_id: "op-2",
              kind: "remove_skill",
              phase: "rolled_back",
              error_code: "operation.conflict",
            },
          ],
          filtered: false,
          limitation: "skill_dimension_not_recorded",
        },
      })
      .mockResolvedValueOnce({
        type: "deterministic_duplicates",
        payload: [
          {
            skill_id: "skill-1-copy",
            label: "PDF Reader（副本）",
            content_hash: "sha256:aa",
          },
        ],
      });

    await expect(nativeSkillDetailFacade.getInsights("skill-1")).resolves.toEqual({
      combinations: [],
      dependencies: [],
      deterministicDuplicates: ["PDF Reader（副本）"],
      externalChanges: [],
      semanticDuplicates: [],
      operationHistory: [
        { id: "op-1", label: "deploy_skill · committed" },
        { id: "op-2", label: "remove_skill · rolled_back · operation.conflict" },
      ],
      operationHistoryLimitation: "skill_dimension_not_recorded",
    });
    expect(queryApplication).toHaveBeenCalledWith({
      type: "list_skill_operations",
      payload: { skill_id: "skill-1" },
    });
  });

  it("submits an explicit finding disposition through the typed native command", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "basic_check_result",
      payload: {
        skill_id: "skill-1",
        version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "passed",
        run_id: "basic-run",
        ruleset_id: "basic-v1",
        checked_at: "2026-08-29T00:00:00Z",
        finding_count: 1,
        actionable_count: 0,
      },
    });

    await expect(setNativeFindingDisposition(
      "skill-1",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "basic",
      "finding-1",
      "acknowledged",
      true,
    )).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_finding_disposition",
      payload: {
        skill_id: "skill-1",
        version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "basic",
        finding_id: "finding-1",
        disposition: "acknowledged",
        high_risk_confirmed: true,
      },
    });
  });

  it("switches the current version through the typed native command", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-1",
        phase: "committed",
        message_code: "catalog.current_version_changed",
        error_code: null,
      },
    });

    await expect(setNativeCurrentVersion("skill-1", "sha256:bbb")).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_current_version",
      payload: { skill_id: "skill-1", version_id: "sha256:bbb" },
    });
  });

  it("maps native versions into readable entries with sequence labels", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "versions",
      payload: [
        { version_id: "sha256:aaaa", skill_id: "skill-1", current: false, file_count: 2, added: 0, changed: 0, removed: 0, created_at_epoch: "1700000000", sequence: 1 },
        { version_id: "sha256:bbbb", skill_id: "skill-1", current: true, file_count: 2, added: 1, changed: 0, removed: 0, created_at_epoch: "1700003600", sequence: 2 },
      ],
    });
    const versions = await nativeSkillDetailFacade.getVersions("skill-1");
    expect(versions[0]).toMatchObject({ id: "sha256:aaaa", label: "v1", sequence: 1, current: false });
    expect(versions[1]).toMatchObject({ id: "sha256:bbbb", label: "v2", sequence: 2, current: true });
    expect(versions[1].createdAtEpoch).toBe("1700003600");
    expect(versions[1].createdAt).not.toBe("");
  });

  it("falls back to a short hash label when capture time is unknown", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "versions",
      payload: [
        { version_id: "sha256:cdef1234abcd5678", skill_id: "skill-1", current: true, file_count: 1, added: 0, changed: 0, removed: 0, created_at_epoch: null, sequence: null },
      ],
    });
    const versions = await nativeSkillDetailFacade.getVersions("skill-1");
    expect(versions[0].label).toBe("sha256:cdef1234…");
    expect(versions[0].createdAt).toBe("");
    expect(versions[0].current).toBe(true);
  });

  it("maps the native version diff", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "version_diff",
      payload: { added: ["new.md"], removed: [], changed: ["SKILL.md"] },
    });
    const diff = await nativeSkillDetailFacade.getVersionDiff("skill-1", "sha256:a", "sha256:b");
    expect(diff).toMatchObject({ added: ["new.md"], changed: ["SKILL.md"], removed: [] });
  });

  it("derives rollback impact from real deployment relations", async () => {
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "deployment_relations",
        payload: [
          { id: "dep-1", skill_id: "skill-1", version_id: "sha256:old", target_id: "target-1", state: "deployed", mode: "managed_copy", managed: true, runtime_name: "pdf", expected_hash: "h", observed_hash: "h" },
        ],
      })
      .mockResolvedValueOnce({
        type: "deployment_targets",
        payload: [{ id: "target-1", label: "Claude Code", path: "C:/x", available: true, physical_id: "p", modes: ["managed_copy"] }],
      });
    const impact = await nativeSkillDetailFacade.getRollbackImpact("skill-1", "sha256:old");
    expect(impact).toEqual({
      deployments: [
        { id: "dep-1", label: "Claude Code", affected: true, pinned: false, version: "sha256:old" },
      ],
      rerunsBasicCheck: true,
      targetVersionId: "sha256:old",
    });
  });

  it("commits a rollback through the native current-version switch", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-1", phase: "committed", message_code: "ok", error_code: null },
    });
    await nativeSkillDetailFacade.commitRollback("skill-1", "sha256:old");
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_current_version",
      payload: { skill_id: "skill-1", version_id: "sha256:old" },
    });
  });
});

describe("native translation loop", () => {
  it("runs translate_description through the typed command with the overwrite flag", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "translation_result",
      payload: {
        skill_id: "skill-1",
        language: "zh-CN",
        text: "提取表格的译文",
        provenance: {
          source_description_hash: "fnv1a:0abc",
          provider: "test",
          model: "test-model",
          origin: "generated" as const,
        },
      },
    });

    await expect(
      nativeSkillDetailFacade.emitIntent({
        locale: "zh-CN",
        overwriteUserRevision: true,
        skillId: "skill-1",
        type: "translate_description",
      }),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "translate_description",
      payload: {
        skill_id: "skill-1",
        language: "zh-CN",
        overwrite_user_revision: true,
      },
    });
  });

  it("persists edited translation text as a user revision via the dedicated contract", async () => {
    vi.clearAllMocks();
    // translationOf 与 saveTranslationRevision 各读一次持久化译文。
    const translations = {
      type: "translations" as const,
      payload: [
        {
          record: {
            skill_id: "skill-1",
            language: "zh-CN",
            text: "提取表格的译文",
            provenance: {
              source_description_hash: "fnv1a:0abc",
              provider: "test",
              model: "test-model",
              origin: "generated" as const,
            },
            origin: "generated" as const,
          },
          version_id: "version-1",
          created_at: "1",
          updated_at: "2",
          needs_update: false,
        },
      ],
    };
    vi.mocked(queryApplication)
      .mockResolvedValueOnce(translations)
      .mockResolvedValueOnce(translations)
      .mockResolvedValue({
        type: "skill",
        payload: {
          skill_id: "skill-1",
          display_name: "PDF Reader",
          runtime_name: "pdf-reader",
          original_description: "Extract tables",
          translated_description: null,
          user_note: null,
          user_purpose: null,
          tags: [],
          author: null,
          license: null,
          lifecycle: "Normal" as const,
          trial_due: null,
          current_version: null,
        },
      });
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({
        type: "translation_result",
        payload: {
          skill_id: "skill-1",
          language: "zh-CN",
          text: "我改的译文",
          provenance: {
            source_description_hash: "fnv1a:0abc",
            provider: "user_revision",
            model: "user_revision",
            origin: "user_revision" as const,
          },
        },
      })
      .mockResolvedValueOnce({
        type: "operation_summary",
        payload: { operation_id: "op-2", phase: "committed", message_code: "ok", error_code: null },
      });
    vi.mocked(executeCommand).mockResolvedValue({
      type: "translation_result",
      payload: {
        skill_id: "skill-1",
        language: "zh-CN",
        text: "我改的译文",
        provenance: {
          source_description_hash: "fnv1a:0abc",
          provider: "user_revision",
          model: "user_revision",
          origin: "user_revision" as const,
        },
      },
    });

    await expect(
      nativeSkillDetailFacade.saveMetadata("skill-1", { translationText: "我改的译文" }),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "save_user_translation_revision",
      payload: {
        skill_id: "skill-1",
        language: "zh-CN",
        source_description_hash: "fnv1a:0abc",
        text: "我改的译文",
      },
    });
  });
});
