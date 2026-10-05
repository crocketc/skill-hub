import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeCommand,
  queryApplication,
  type RelationshipOverview,
} from "../../api/bindings";
import { skillHubI18n } from "../../i18n";
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
  // mockReset 清掉 mockResolvedValueOnce 队列：排队的"下一次结果"如果残留，
  // 会让后续测试读到上一个测试的 payload（表现为无关的 unavailable 错误）。
  beforeEach(() => {
    vi.mocked(queryApplication).mockReset();
    vi.mocked(executeCommand).mockReset();
  });

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
    // DEV-16：summary 必须携带别名（display_name ≠ runtime_name 时），
    // 头部别名的唯一展示位不能回退到裸 SkillId。
    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      id: "skill-1",
      name: "PDF Reader",
      alias: "PDF Reader",
      purpose: "用于 PDF 表格提取",
      lifecycle: "trial",
      trialDue: "2026-09-15",
      agentDeploymentCount: undefined,
      highRiskCount: undefined,
      pendingCount: undefined,
      projectDeploymentCount: undefined,
      upgradeAvailable: undefined,
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

  it("maps pending and high-risk counts, deployment counts, and upstream availability from the native summary", async () => {
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
        user_purpose: "Extract tables from PDFs",
        tags: [],
        author: null,
        license: null,
        lifecycle: "Normal",
        trial_due: null,
        current_version: null,
        current_version_label: null,
        agent_deployment_count: 3,
        project_deployment_count: 2,
        pending_count: 4,
        high_risk_count: 1,
        upstream_state: "update_available",
        // G-16：托管链接与独立副本计数与列表同源；概要必须透传真实值。
        managed_link_count: 2,
        independent_copy_count: 5,
        // K9：可见树根来自真实物化事实；接管预填与打开命令都取这个绝对路径。
        root_path: "C:/SkillHub/library/pdf-reader",
      },
    } as never);

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      agentDeploymentCount: 3,
      highRiskCount: 1,
      pendingCount: 4,
      projectDeploymentCount: 2,
      upgradeAvailable: true,
      managedLinkCount: 2,
      independentCopyCount: 5,
      rootPath: "C:/SkillHub/library/pdf-reader",
    });
  });

  // K5/MS-04：上游谱系原样透传给详情摘要；None=无登记，不做任何派生。
  it("carries the upstream reuse-modify lineage through to the summary", async () => {
    const lineage = {
      created_at: "1728000000",
      source_display_name: "Source skill",
      source_skill_id: "skill-src",
      source_version_id: "ver-src",
    };
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
        lifecycle: "Normal",
        trial_due: null,
        current_version: null,
        upstream_lineage: lineage,
      },
    } as never);

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      upstreamLineage: lineage,
    });
  });

  it("keeps the upstream lineage absent when the backend registers none", async () => {
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
        lifecycle: "Normal",
        trial_due: null,
        current_version: null,
      },
    } as never);

    const summary = await nativeSkillDetailFacade.getSummary("skill-1");
    expect(summary.upstreamLineage).toBeUndefined();
  });

  it("keeps the summary tree root unknown when the backend reports no materialized tree", async () => {
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
        lifecycle: "Normal",
        trial_due: null,
        current_version: null,
        root_path: null,
      },
    } as never);

    const summary = await nativeSkillDetailFacade.getSummary("skill-1");
    expect(summary.rootPath).toBeUndefined();
  });

  it("presents Deprecated without treating it as Skill archive", async () => {
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
        lifecycle: "Deprecated",
        trial_due: null,
        current_version: null,
      },
    } as never);

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      lifecycle: "deprecated",
      trialDue: undefined,
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

  it("sends only changed metadata fields through the native patch contract", async () => {
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

    expect(queryApplication).not.toHaveBeenCalledWith({
      type: "get_skill",
      payload: { skill_id: "skill-1" },
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: "patch_skill_metadata",
      payload: {
        skill_id: "skill-1",
        patch: {
          user_purpose: "新的本地用途",
          tags: ["new-tag"],
        },
      },
    });
  });

  it("applies a single-field metadata update without reading the whole Skill first", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "skill",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        runtime_name: "pdf-reader",
        original_description: "Extract tables",
        translated_description: null,
        user_note: "old note",
        user_purpose: null,
        tags: ["documents"],
        author: "Ada",
        license: "MIT",
        lifecycle: "Normal",
        trial_due: null,
        current_version: null,
        current_version_label: null,
        agent_deployment_count: 0,
        project_deployment_count: 0,
        pending_count: 0,
        high_risk_count: 0,
      },
    } as never);
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-patch", phase: "committed", message_code: "ok", error_code: null },
    });

    await nativeSkillDetailFacade.saveMetadata("skill-1", { note: "new note" });

    expect(queryApplication).not.toHaveBeenCalledWith({
      type: "get_skill",
      payload: { skill_id: "skill-1" },
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: "patch_skill_metadata",
      payload: {
        skill_id: "skill-1",
        patch: { note: "new note" },
      },
    });
  });

  it("clears only the alias through the tri-state metadata contract", async () => {
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

    expect(queryApplication).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "patch_skill_metadata",
      payload: { skill_id: "skill-1", patch: { display_name: null } },
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

  it("resolves a relation recorded with the physical target id (DEV-22-A)", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "deployment_relations",
        payload: [{
          id: "deployment-1",
          skill_id: "skill-1",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          // 真实提交写的是物理目标 id；详情/关系页必须仍能回查到目标。
          target_id: "fs:codex",
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
          path: "C:/Users/demo/.codex/skills/",
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
      logicalTarget: "fs:codex",
      physicalTarget: "C:/Users/demo/.codex/skills/pdf-reader",
      pinned: false,
      version: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }]);
  });

  it("queries the real skill insights projection and maps it to readable facts", async () => {
    const previousLanguage = skillHubI18n.language;
    try {
      await skillHubI18n.changeLanguage("zh-CN");
      // G-18：组合/依赖/外部变化/操作历史全部来自 get_skill_insights 真实读模型；
      // 确定性重复候选仍来自既有 list_deterministic_duplicates 查询。
      vi.mocked(queryApplication)
        .mockResolvedValueOnce({
          type: "skill_insights",
          payload: {
            skill_id: "skill-1",
            combinations: [
              { name: "Document toolkit", other_member_labels: ["Spreadsheet Reader", "表格读取"] },
            ],
            dependencies: [
              {
                relation_id: "relation-1",
                path: "C:/Users/demo/.codex/skills/pdf-reader",
                agent_client_id: "openai.codex-cli",
                shape_code: "managed_link",
              },
              {
                relation_id: "relation-2",
                path: "C:/Projects/demo/skills-copy",
                agent_client_id: null,
                shape_code: "import_copy",
              },
            ],
            external_changes: [
              { relation_id: "relation-1", path: "SKILL.md", state_code: "content_diverged" },
            ],
            operation_history: [
              {
                operation_id: "op-1",
                message_code: "insights.operation.skill_added.succeeded",
                at_epoch: "1757808000",
              },
              {
                operation_id: "op-2",
                message_code: "insights.operation.content_saved.failed",
                at_epoch: null,
              },
            ],
            operation_history_limitation: "skill_dimension_not_recorded",
          },
        } as never)
        .mockResolvedValueOnce({
          type: "deterministic_duplicates",
          payload: [
            {
              skill_id: "skill-1-copy",
              label: "PDF Reader（副本）",
              content_hash: "sha256:aa",
            },
          ],
        } as never);

      const insights = await nativeSkillDetailFacade.getInsights("skill-1");
      expect(insights).toEqual({
        combinations: [
          { name: "Document toolkit", otherMemberLabels: ["Spreadsheet Reader", "表格读取"] },
        ],
        dependencies: [
          {
            agentClientId: "openai.codex-cli",
            id: "relation-1",
            path: "C:/Users/demo/.codex/skills/pdf-reader",
            shapeLabel: "托管链接",
          },
          {
            agentClientId: null,
            id: "relation-2",
            path: "C:/Projects/demo/skills-copy",
            shapeLabel: "导入副本",
          },
        ],
        deterministicDuplicates: ["PDF Reader（副本）"],
        externalChanges: [
          { id: "relation-1", path: "SKILL.md", stateLabel: "内容已与集中库分叉" },
        ],
        operationHistory: [
          { id: "op-1", label: "添加 Skill · 已完成", at: new Date(1757808000 * 1000).toLocaleString() },
          { id: "op-2", label: "保存内容 · 失败" },
        ],
        operationHistoryLimitation: "skill_dimension_not_recorded",
      });
      expect(queryApplication).toHaveBeenCalledWith({
        type: "get_skill_insights",
        payload: { skill_id: "skill-1" },
      });
    } finally {
      await skillHubI18n.changeLanguage(previousLanguage);
    }
  });

  it("answers unknown insight codes with honest fallbacks instead of raw internals", async () => {
    const previousLanguage = skillHubI18n.language;
    try {
      await skillHubI18n.changeLanguage("zh-CN");
      vi.clearAllMocks();
      vi.mocked(queryApplication)
        .mockResolvedValueOnce({
          type: "skill_insights",
          payload: {
            skill_id: "skill-1",
            combinations: [],
            dependencies: [
              {
                relation_id: "relation-x",
                path: "C:/mirrored",
                agent_client_id: null,
                shape_code: "vendor_future_shape",
              },
            ],
            external_changes: [
              { relation_id: "relation-x", path: "notes.md", state_code: "vendor_future_state" },
            ],
            operation_history: [
              {
                operation_id: "op-x",
                message_code: "insights.operation.vendor_task.future_result",
                at_epoch: null,
              },
            ],
            operation_history_limitation: null,
          },
        } as never)
        .mockResolvedValueOnce({ type: "deterministic_duplicates", payload: [] } as never);

      const insights = await nativeSkillDetailFacade.getInsights("skill-1");
      // 未映射的新枚举回退到通用类别词，不把机器码裸露给用户，也不编造类型。
      expect(insights.dependencies[0]?.shapeLabel).toBe("vendor_future_shape");
      expect(insights.externalChanges[0]?.stateLabel).toBe("vendor_future_state");
      const label = insights.operationHistory[0]?.label ?? "";
      expect(label).toBe("Skill 操作 · 状态不可用");
      expect(label).not.toContain("vendor_task");
      expect(label).not.toContain("future_result");
      // limitation 为 null 时不得渲染限制说明。
      expect(insights.operationHistoryLimitation).toBeUndefined();
    } finally {
      await skillHubI18n.changeLanguage(previousLanguage);
    }
  });

  it("localizes known insight facts consistently in both locales", async () => {
    const previousLanguage = skillHubI18n.language;
    const insightsPayload = {
      type: "skill_insights" as const,
      payload: {
        skill_id: "skill-1",
        combinations: [],
        dependencies: [
          {
            relation_id: "r-1",
            path: "C:/link",
            agent_client_id: null,
            shape_code: "managed_link",
          },
        ],
        external_changes: [
          { relation_id: "r-1", path: "SKILL.md", state_code: "content_diverged" },
        ],
        operation_history: [
          {
            operation_id: "op-known",
            message_code: "insights.operation.deployment_reconciled.rolled_back",
            at_epoch: null,
          },
        ],
        operation_history_limitation: null as string | null,
      },
    };
    const loadInsights = async () => {
      vi.clearAllMocks();
      vi.mocked(queryApplication)
        .mockResolvedValueOnce(insightsPayload as never)
        .mockResolvedValueOnce({ type: "deterministic_duplicates", payload: [] } as never);
      return nativeSkillDetailFacade.getInsights("skill-1");
    };

    try {
      await skillHubI18n.changeLanguage("zh-CN");
      const chinese = await loadInsights();
      expect(chinese.dependencies[0]?.shapeLabel).toBe("托管链接");
      expect(chinese.externalChanges[0]?.stateLabel).toBe("内容已与集中库分叉");
      expect(chinese.operationHistory[0]?.label).toBe("核对部署 · 已撤销");

      await skillHubI18n.changeLanguage("en-US");
      const english = await loadInsights();
      expect(english.dependencies[0]?.shapeLabel).toBe("Managed link");
      expect(english.externalChanges[0]?.stateLabel).toBe("Content diverged from the central library");
      expect(english.operationHistory[0]?.label).toBe("Deployment reconciled · Rolled back");
    } finally {
      await skillHubI18n.changeLanguage(previousLanguage);
    }
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

  it("switches the current version through the preview-bound native command", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "rollback_impact",
      payload: {
        skill_id: "skill-1",
        current_version_id: "sha256:aaa",
        database_current_version_id: "sha256:aaa",
        portable_current_version_id: "sha256:aaa",
        visible_tree_fingerprint: "fp-1",
        target_version_id: "sha256:bbb",
        preview_id: "preview-1",
        expires_at: "2026-10-04T00:00:00Z",
        confirmation_fingerprint: "cf-1",
        target_basic_check_required: false,
        relations: [],
      },
    } as never);
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
    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_rollback_impact",
      payload: { skill_id: "skill-1", target_version_id: "sha256:bbb" },
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_current_version",
      payload: {
        skill_id: "skill-1",
        version_id: "sha256:bbb",
        preview_id: "preview-1",
      },
    });
  });

  it("refuses to switch the current version without a fresh preview", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "versions",
      payload: [],
    } as never);

    await expect(setNativeCurrentVersion("skill-1", "sha256:bbb")).rejects.toThrow();
    expect(executeCommand).not.toHaveBeenCalled();
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

  it("prefers the user-named version label the native list returns", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "versions",
      payload: [
        { version_id: "sha256:aaaa", skill_id: "skill-1", current: true, file_count: 2, added: 0, changed: 0, removed: 0, created_at_epoch: "1700000000", sequence: 3, label: "1.0 正式版" },
      ],
    });
    const versions = await nativeSkillDetailFacade.getVersions("skill-1");
    // 契约声明的优先级是「用户命名 → vN 序号 → 短哈希」；丢弃用户命名会让
    // 命名版本在界面上完全没有效果。
    expect(versions[0].label).toBe("1.0 正式版");
    expect(versions[0].userLabel).toBe("1.0 正式版");
    expect(versions[0].sequence).toBe(3);
  });

  it("falls back to the sequence label when the native version list has no user name", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "versions",
      payload: [
        { version_id: "sha256:aaaa", skill_id: "skill-1", current: true, file_count: 2, added: 0, changed: 0, removed: 0, created_at_epoch: "1700000000", sequence: 3, label: "   " },
      ],
    });
    const versions = await nativeSkillDetailFacade.getVersions("skill-1");
    expect(versions[0].label).toBe("v3");
    expect(versions[0].userLabel).toBeUndefined();
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

  it("wires the trial review date to the native set_trial command", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-1", phase: "committed", message_code: "ok", error_code: null },
    });
    await nativeSkillDetailFacade.setTrial("skill-1", "2026-10-01");
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_trial",
      payload: { skill_id: "skill-1", due: [2026, 10, 1] },
    });
  });

  it("clears the trial review date through the same contract when the caller passes null", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-1", phase: "committed", message_code: "ok", error_code: null },
    });
    await nativeSkillDetailFacade.setTrial("skill-1", null);
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_trial",
      payload: { skill_id: "skill-1", due: null },
    });
  });

  it("commits a rollback through the native current-version switch", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "rollback_impact",
      payload: {
        skill_id: "skill-1",
        current_version_id: "sha256:new",
        database_current_version_id: null,
        portable_current_version_id: null,
        visible_tree_fingerprint: null,
        target_version_id: "sha256:old",
        preview_id: "preview-rollback-1",
        expires_at: "2026-10-04T00:00:00Z",
        confirmation_fingerprint: "cf-1",
        target_basic_check_required: false,
        relations: [],
      },
    } as never);
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-1", phase: "committed", message_code: "ok", error_code: null },
    });
    await nativeSkillDetailFacade.commitRollback("skill-1", "sha256:old");
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_current_version",
      payload: {
        skill_id: "skill-1",
        version_id: "sha256:old",
        preview_id: "preview-rollback-1",
      },
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
    ).resolves.toEqual({ text: "提取表格的译文" });
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

describe("K6 source update preview bindings", () => {
  it("prepares a source update preview through the typed command", async () => {
    vi.clearAllMocks();
    const previewPayload = {
      skill_id: "skill-1",
      preview_id: "preview-1",
      expires_at: "2026-10-04T12:00:00Z",
      confirmation_fingerprint: "fp-1",
      current_version_id: "sha256:v3",
      candidate_identity: "sha256:cand",
      upstream_label: "v4.0",
      files: [
        { path: "SKILL.md", change: "modified" },
        { path: "new.md", change: "added" },
      ],
    };
    vi.mocked(executeCommand).mockResolvedValue({
      type: "source_update_preview",
      payload: previewPayload,
    } as never);

    await expect(nativeSkillDetailFacade.prepareSourceUpdate("skill-1")).resolves.toBe(previewPayload);
    expect(executeCommand).toHaveBeenCalledWith({
      type: "prepare_source_update",
      payload: { skill_id: "skill-1" },
    });
  });

  it("refuses to continue when prepare returns an unexpected result", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-1", phase: "committed", message_code: "ok", error_code: null },
    } as never);

    await expect(nativeSkillDetailFacade.prepareSourceUpdate("skill-1")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && error.name === "SkillDetailUnavailableError",
    );
  });

  it("commits a preview decision with the preview id only", async () => {
    vi.clearAllMocks();
    const applied = {
      skill_id: "skill-1",
      decision: "take_upstream",
      new_version: "sha256:v4",
      deployments_need_reconciliation: true,
    };
    vi.mocked(executeCommand).mockResolvedValue({
      type: "applied_source_update",
      payload: applied,
    } as never);

    await expect(
      nativeSkillDetailFacade.commitSourceUpdate("preview-1", "take_upstream"),
    ).resolves.toBe(applied);
    expect(executeCommand).toHaveBeenCalledWith({
      type: "commit_source_update",
      payload: { preview_id: "preview-1", decision: "take_upstream" },
    });
  });

  it("ignores a candidate by its identity through the typed command", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-ignore",
        phase: "committed",
        message_code: "source.update_ignored",
        error_code: null,
      },
    } as never);

    await expect(
      nativeSkillDetailFacade.ignoreSourceUpdate("skill-1", "sha256:cand"),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "ignore_source_update",
      payload: { skill_id: "skill-1", candidate_identity: "sha256:cand" },
    });
  });

  it("reads the persisted source update status including the never-checked default", async () => {
    vi.clearAllMocks();
    const status = {
      skill_id: "skill-1",
      state: null,
      checked_at: null,
      upstream_label: null,
      candidate_identity: null,
      ignored_candidates: ["sha256:old"],
      candidate_ignored: false,
    };
    vi.mocked(queryApplication).mockResolvedValue({
      type: "source_update_status",
      payload: status,
    } as never);

    await expect(nativeSkillDetailFacade.getSourceUpdateStatus("skill-1")).resolves.toBe(status);
    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_source_update_status",
      payload: { skill_id: "skill-1" },
    });
  });

  it("builds the relink locator from the user-selected kind, never from guessing", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: { operation_id: "op-1", phase: "committed", message_code: "source.relinked", error_code: null },
    } as never);

    await nativeSkillDetailFacade.relinkSource("skill-1", { kind: "local", value: " C:/src " });
    await nativeSkillDetailFacade.relinkSource("skill-1", {
      kind: "https",
      value: "https://github.com/o/r",
    });
    await nativeSkillDetailFacade.relinkSource("skill-1", { kind: "git", value: "git@github.com:o/r.git" });

    expect(executeCommand).toHaveBeenNthCalledWith(1, {
      type: "relink_source",
      payload: { skill_id: "skill-1", source: { kind: "local", locator: { local_path: "C:/src" } } },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: "relink_source",
      payload: {
        skill_id: "skill-1",
        source: { kind: "https", locator: { https_url: "https://github.com/o/r" } },
      },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: "relink_source",
      payload: {
        skill_id: "skill-1",
        source: { kind: "git", locator: { git_url: "git@github.com:o/r.git" } },
      },
    });
  });
});

describe("native relationship governance queries", () => {
  it("loads the relationship overview scoped to the skill", async () => {
    const overview: RelationshipOverview = {
      scope: { type: "skill", value: { skill_id: "skill-1" } },
      directory_nodes: [],
      agent_directory_capabilities: [],
      source_relations: [],
      deployment_relations: [],
      conflict_cases: [],
      pending_governance_tasks: [],
      agent_execution_confirmed: false,
    };
    vi.mocked(queryApplication).mockResolvedValueOnce({
      type: "relationship_overview",
      payload: overview,
    });

    await expect(nativeSkillDetailFacade.getRelationshipOverview("skill-1")).resolves.toBe(overview);
    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_relationship_overview",
      payload: { scope: { type: "skill", value: { skill_id: "skill-1" } } },
    });
  });

  it("surfaces relationship overview failures instead of an empty view", async () => {
    vi.mocked(queryApplication).mockRejectedValueOnce(new Error("overview failed"));

    await expect(nativeSkillDetailFacade.getRelationshipOverview("skill-1")).rejects.toThrow(
      "overview failed",
    );
  });

  it("loads the governed removal impact for one relation", async () => {
    const impact = {
      relation_id: "rel-1",
      relation: null,
      ownership: "skillhub_managed",
      current_agent_reads_shared_directory: false,
      other_consumers: [],
      other_skill_paths: [],
      minimal_action: "create_governance_task",
      backup: { required: false, rollback_available: false, backup_location: null, detail: "" },
      governance_tasks: [],
      permission_limited: false,
    } as never;
    vi.mocked(queryApplication).mockResolvedValueOnce({
      type: "relationship_removal_impact",
      payload: impact,
    });

    await expect(nativeSkillDetailFacade.getRelationshipRemovalImpact("rel-1")).resolves.toBe(impact);
    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_relationship_removal_impact",
      payload: { relation_id: "rel-1" },
    });
  });

  it("surfaces removal impact failures instead of an empty impact", async () => {
    vi.mocked(queryApplication).mockRejectedValueOnce(new Error("impact failed"));

    await expect(nativeSkillDetailFacade.getRelationshipRemovalImpact("rel-1")).rejects.toThrow(
      "impact failed",
    );
  });
});
