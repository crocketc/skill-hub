import { describe, expect, it, vi } from "vitest";
import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type SkillListItem,
  type SkillResult,
} from "../../api/bindings";
import { DEFAULT_SKILL_QUERY, SkillLibraryUnavailableError } from "./api";
import { nativeSkillLibraryFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

function nativeItem(overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    skill_id: "skill-1",
    display_name: "PDF Reader",
    runtime_name: "pdf-reader",
    original_description: "Extract tables",
    translated_description: null,
    user_note: null,
    user_purpose: null,
    tags: ["documents"],
    license: "MIT",
    lifecycle: "Normal",
    trial_due: null,
    author: null,
    source_kind: null,
    source_locator: null,
    current_version: null,
    current_version_label: null,
    agent_deployment_count: 0,
    agent_deployment_target_ids: [],
    project_deployment_count: 0,
    basic_check: "not_checked",
    ai_check: "not_checked",
    high_risk_count: 0,
    ...overrides,
  };
}

function skillPage(items: SkillListItem[]): AppQueryResult {
  return {
    type: "skill_page",
    payload: {
      items,
      total: items.length,
      page: 1,
      page_size: 25,
      tags: [...new Set(items.flatMap((item) => item.tags))],
    },
  };
}

describe("native skill library facade", () => {
  it("falls back to the enhanced card view when a stored view mode is unrecognized", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "ui_preference",
      payload: { key: "library_view_mode", value_json: JSON.stringify("compact-list") },
    } as AppQueryResult);

    await expect(nativeSkillLibraryFacade.loadViewMode?.()).resolves.toBe("cards");
  });

  it("maps a typed skill page into the desktop table row contract", async () => {
    vi.mocked(queryApplication).mockResolvedValue(
      skillPage([nativeItem()]),
    );

    const page = await nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY);

    expect(queryApplication).toHaveBeenCalledWith({
      type: "list_skills",
      payload: {
        text: "",
        page: 1,
        page_size: 25,
        filters: { ai_check: [], basic_check: [], deployment: "any", lifecycle: [], tags: [] },
        sort: { column: "name", direction: "asc" },
      },
    });
    expect(page.items[0]).toMatchObject({
      id: "skill-1",
      name: "PDF Reader",
      purpose: "Extract tables",
      lifecycle: "active",
      basicCheck: "not_run",
      aiCheck: "not_run",
      tags: ["documents"],
      license: "MIT",
    });
    expect(page.total).toBe(1);
    expect(page.facets.tags).toEqual(["documents"]);
  });

  // P1-10：别名只覆盖展示名；原名（runtime_name）必须在读模型中如实可达。
  it("maps an aliased display name to the alias plus the untouched runtime name", async () => {
    vi.mocked(queryApplication).mockResolvedValue(skillPage([nativeItem()]));

    const page = await nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY);

    expect(page.items[0].name).toBe("PDF Reader");
    expect(page.items[0].alias).toBe("PDF Reader");
    expect(page.items[0].originalName).toBe("pdf-reader");
  });

  it("omits the alias when the display name equals the runtime name", async () => {
    vi.mocked(queryApplication).mockResolvedValue(
      skillPage([nativeItem({ display_name: "pdf-reader" })]),
    );

    const page = await nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY);

    expect(page.items[0].name).toBe("pdf-reader");
    expect(page.items[0].alias).toBeUndefined();
    expect(page.items[0].originalName).toBe("pdf-reader");
  });

  it("fills the quick view with the runtime name and only a user-set alias", async () => {
    vi.mocked(queryApplication).mockResolvedValue(persistedSkill());

    const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-1");

    expect(view.name).toBe("Renamed Reader");
    expect(view.alias).toBe("Renamed Reader");
    expect(view.originalName).toBe("pdf-reader");
    expect(view.tags).toEqual(["documents"]);
  });

  it("fills the quick view without an alias when the display name is the runtime name", async () => {
    vi.mocked(queryApplication).mockResolvedValue(
      persistedSkill({ display_name: "pdf-reader" }),
    );

    const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-1");

    expect(view.alias).toBeUndefined();
    expect(view.originalName).toBe("pdf-reader");
  });

  it("maps the persisted status read model onto the table row", async () => {
    vi.mocked(queryApplication)
      .mockResolvedValueOnce(
        skillPage([
          nativeItem({
            author: "Ada",
            source_kind: "local",
            source_locator: "C:\\sources\\pdf-reader",
            current_version: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            current_version_label: "1.4.0",
            agent_deployment_count: 1,
            agent_deployment_target_ids: ["agent-codex"],
            project_deployment_count: 2,
            basic_check: "failed",
            ai_check: "running",
            high_risk_count: 1,
          }),
        ]),
      )
      .mockResolvedValueOnce({
        type: "deployment_targets",
        payload: [
          {
            id: "agent-codex",
            label: "Codex CLI",
            path: "C:\\agents\\codex",
            available: true,
            physical_id: "codex",
            modes: [],
          },
        ],
      });

    const page = await nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY);

    expect(page.items[0]).toMatchObject({
      ownership: "Ada",
      source: "C:\\sources\\pdf-reader",
      currentVersion: "1.4.0",
      agentDeploymentCount: 1,
      agentDeployments: [{ id: "codex", name: "Codex CLI" }],
      projectDeploymentCount: 2,
      basicCheck: "failed",
      aiCheck: "warning",
      highRiskCount: 1,
    });
  });

  it("keeps raw target ids when the deployment target lookup cannot resolve them", async () => {
    vi.mocked(queryApplication)
      .mockResolvedValueOnce(
        skillPage([nativeItem({ agent_deployment_target_ids: ["agent-codex"] })]),
      )
      .mockRejectedValueOnce(new Error("target lookup failed"));

    const page = await nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY);

    expect(page.items[0].agentDeployments).toEqual([{ id: "agent-codex", name: "agent-codex" }]);
  });

  it("forwards supported filters and sorting through the native query contract", async () => {
    vi.mocked(queryApplication).mockResolvedValue(skillPage([]));

    await nativeSkillLibraryFacade.listSkills({
      ...DEFAULT_SKILL_QUERY,
      filters: {
        ...DEFAULT_SKILL_QUERY.filters,
        basicCheck: ["passed", "warning"],
        aiCheck: ["not_run"],
        deployment: "deployed",
        lifecycle: ["trial", "archived"],
        tags: ["documents"],
      },
      sort: { column: "agent_deployments", direction: "desc" },
    });

    expect(queryApplication).toHaveBeenCalledWith({
      type: "list_skills",
      payload: {
        text: "",
        page: 1,
        page_size: 25,
        filters: {
          ai_check: ["not_checked"],
          basic_check: ["passed", "running"],
          deployment: "deployed",
          lifecycle: ["trial", "archived"],
          tags: ["documents"],
        },
        sort: { column: "agent_deployments", direction: "desc" },
      },
    });
  });

  it("turns an unexpected native result into the standard unavailable error", async () => {
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

    await expect(nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY)).rejects.toSatisfy(
      (error) => error instanceof Error && error.name === "SkillLibraryUnavailableError",
    );
  });

  it("rejects filters and sorts that still have no native read model", async () => {
    vi.clearAllMocks();
    await expect(
      nativeSkillLibraryFacade.listSkills({
        ...DEFAULT_SKILL_QUERY,
        filters: { ...DEFAULT_SKILL_QUERY.filters, version: "upgrade_available" },
      }),
    ).rejects.toSatisfy(
      (error) => error instanceof Error && error.name === "SkillLibraryUnavailableError",
    );
    await expect(
      nativeSkillLibraryFacade.listSkills({
        ...DEFAULT_SKILL_QUERY,
        sort: { column: "security", direction: "asc" },
      }),
    ).rejects.toSatisfy(
      (error) => error instanceof Error && error.name === "SkillLibraryUnavailableError",
    );
    await expect(
      nativeSkillLibraryFacade.listSkills({
        ...DEFAULT_SKILL_QUERY,
        filters: { ...DEFAULT_SKILL_QUERY.filters, basicCheck: ["unavailable"] },
      }),
    ).rejects.toSatisfy(
      (error) => error instanceof Error && error.name === "SkillLibraryUnavailableError",
    );
    expect(queryApplication).not.toHaveBeenCalled();
  });

  it("runs a batch source update check through the native query contract", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "source_update_checks",
      payload: [
        { skill_id: "skill-1", state: "up_to_date" },
        { skill_id: "skill-2", state: "update_available" },
        { skill_id: "skill-3", state: "source_unavailable" },
      ],
    } as AppQueryResult);

    const entries = await nativeSkillLibraryFacade.checkSourceUpdates?.([
      "skill-1",
      "skill-2",
      "skill-3",
    ]);

    expect(queryApplication).toHaveBeenCalledWith({
      type: "check_source_updates",
      payload: { skill_ids: ["skill-1", "skill-2", "skill-3"] },
    });
    expect(entries).toEqual([
      { skillId: "skill-1", state: "up_to_date" },
      { skillId: "skill-2", state: "update_available" },
      { skillId: "skill-3", state: "source_unavailable" },
    ]);
  });

  it("turns an unexpected batch source update result into the standard unavailable error", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "running_llm_checks",
      payload: [],
    } as AppQueryResult);

    await expect(nativeSkillLibraryFacade.checkSourceUpdates?.(["skill-1"])).rejects.toSatisfy(
      (error) => error instanceof Error && error.name === "SkillLibraryUnavailableError",
    );
  });
});

it("fills the quick drawer duplicate candidates from the deterministic read model", async () => {
  vi.mocked(queryApplication).mockImplementation(async (request) => {
    if (request.type === "get_skill") {
      return {
        type: "skill",
        payload: { skill_id: "skill-a", display_name: "Notes A", runtime_name: "notes-a", original_description: "", translated_description: null, user_note: null, user_purpose: null, tags: [], author: null, license: null, lifecycle: "Normal", trial_due: null, current_version: "v-hash" },
      };
    }
    if (request.type === "list_deterministic_duplicates") {
      expect(request.payload).toEqual({ skill_id: "skill-a" });
      return {
        type: "deterministic_duplicates",
        payload: [{ skill_id: "skill-b", label: "Notes B", content_hash: "hash-a" }],
      };
    }
    throw new Error("unexpected query " + request.type);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-a");
  expect(view.duplicateCandidates).toEqual(["Notes B"]);
});

function persistedSkill(overrides: Partial<SkillResult> = {}): AppQueryResult {
  return {
    type: "skill",
    payload: {
      skill_id: "skill-1",
      display_name: "Renamed Reader",
      runtime_name: "pdf-reader",
      original_description: "Extract tables",
      translated_description: null,
      user_note: "Keep near docs",
      user_purpose: "用于 PDF 表格提取",
      tags: ["documents"],
      author: "Platform team",
      license: "MIT",
      lifecycle: "Normal",
      trial_due: null,
      current_version: null,
      ...overrides,
    },
  };
}

function savedSummary(): AppCommandResult {
  return {
    type: "operation_summary",
    payload: {
      operation_id: "op-metadata-1",
      phase: "committed",
      message_code: "metadata.saved",
      error_code: null,
    },
  };
}

describe("native skill metadata save", () => {
  it("merges an alias patch into the full metadata contract without dropping fields", async () => {
    vi.mocked(queryApplication).mockResolvedValue(persistedSkill());
    vi.mocked(executeCommand).mockResolvedValue(savedSummary());

    await nativeSkillLibraryFacade.saveSkillMetadata!("skill-1", { alias: "PDF helper" });

    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_skill",
      payload: { skill_id: "skill-1" },
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_metadata",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF helper",
        note: "Keep near docs",
        tags: ["documents"],
        author: "Platform team",
        license: "MIT",
        user_purpose: "用于 PDF 表格提取",
      },
    });
  });

  it("reverts a cleared alias to the runtime name and preserves the other metadata", async () => {
    vi.mocked(queryApplication).mockResolvedValue(persistedSkill());
    vi.mocked(executeCommand).mockResolvedValue(savedSummary());

    await nativeSkillLibraryFacade.saveSkillMetadata!("skill-1", { alias: null });

    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_metadata",
      payload: {
        skill_id: "skill-1",
        display_name: "pdf-reader",
        note: "Keep near docs",
        tags: ["documents"],
        author: "Platform team",
        license: "MIT",
        user_purpose: "用于 PDF 表格提取",
      },
    });
  });

  it("saves a note without changing the display alias", async () => {
    vi.mocked(queryApplication).mockResolvedValue(persistedSkill());
    vi.mocked(executeCommand).mockResolvedValue(savedSummary());

    await nativeSkillLibraryFacade.saveSkillMetadata!("skill-1", { note: "Use for invoices" });

    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_metadata",
      payload: {
        skill_id: "skill-1",
        display_name: "Renamed Reader",
        note: "Use for invoices",
        tags: ["documents"],
        author: "Platform team",
        license: "MIT",
        user_purpose: "用于 PDF 表格提取",
      },
    });
  });

  // P1-10：标签写沿用 set_metadata 的整体覆盖契约；未提供的字段先读后并，
  // 别名清空仍回退 runtime_name，全程不允许出现 rename_skill。
  it("persists a tags patch while keeping the alias and remaining metadata", async () => {
    vi.mocked(queryApplication).mockResolvedValue(persistedSkill());
    vi.mocked(executeCommand).mockClear();
    vi.mocked(executeCommand).mockResolvedValue(savedSummary());

    await nativeSkillLibraryFacade.saveSkillMetadata!("skill-1", {
      tags: ["documents", "review"],
    });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_metadata",
      payload: {
        skill_id: "skill-1",
        display_name: "Renamed Reader",
        note: "Keep near docs",
        tags: ["documents", "review"],
        author: "Platform team",
        license: "MIT",
        user_purpose: "用于 PDF 表格提取",
      },
    });
    expect(executeCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "rename_skill" }),
    );
  });

  it("keeps the stored tags when a patch omits them", async () => {
    vi.mocked(queryApplication).mockResolvedValue(persistedSkill());
    vi.mocked(executeCommand).mockResolvedValue(savedSummary());

    await nativeSkillLibraryFacade.saveSkillMetadata!("skill-1", { alias: null });

    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "set_metadata",
        payload: expect.objectContaining({
          display_name: "pdf-reader",
          tags: ["documents"],
        }),
      }),
    );
  });
});

describe("native combination rename wiring", () => {
  it("sends rename_combination and returns the updated combination view", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "combination",
      payload: { name: "Reading stack", members: ["skill-1", "skill-2"] },
    } as AppCommandResult);

    await expect(
      nativeSkillLibraryFacade.renameCombination?.("Writing stack", "Reading stack"),
    ).resolves.toEqual({ name: "Reading stack", members: ["skill-1", "skill-2"] });

    expect(executeCommand).toHaveBeenCalledWith({
      type: "rename_combination",
      payload: { from: "Writing stack", to: "Reading stack" },
    });
  });

  it("turns an unexpected rename result into the standard unavailable error", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-rename-1",
        phase: "committed",
        message_code: "operation.rename_combination.committed",
        error_code: null,
      },
    } as AppCommandResult);

    await expect(
      nativeSkillLibraryFacade.renameCombination?.("Writing stack", "Reading stack"),
    ).rejects.toBeInstanceOf(SkillLibraryUnavailableError);
  });
});
