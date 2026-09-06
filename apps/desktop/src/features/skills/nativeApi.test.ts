import { describe, expect, it, vi } from "vitest";
import { queryApplication, type AppQueryResult, type SkillListItem } from "../../api/bindings";
import { DEFAULT_SKILL_QUERY } from "./api";
import { nativeSkillLibraryFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
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
